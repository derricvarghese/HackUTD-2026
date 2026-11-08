import CoreBluetooth
import Foundation

public protocol BLETransportDelegate: AnyObject {
    func transport(_ transport: BLETransport, peerReady peer: String)
    func transport(_ transport: BLETransport, peerLost peer: String)
    func transport(_ transport: BLETransport, received envelopeJSON: Data, from peer: String)
    func transport(_ transport: BLETransport, log message: String)
}

/// BLE GATT transport that interoperates with the Android `BleMeshTransport`.
///
/// Every phone is both a peripheral (advertises the Beacon service, accepts writes on RX)
/// and a central (scans, connects to every Beacon peer, writes chunks to their RX).
/// All CoreBluetooth callbacks run on the main queue.
public final class BLETransport: NSObject, MeshTransport {
    public weak var delegate: BLETransportDelegate?

    private let serviceUUID = CBUUID(string: MeshProtocol.serviceUUID)
    private let rxUUID = CBUUID(string: MeshProtocol.rxCharacteristicUUID)

    private var central: CBCentralManager!
    private var peripheralManager: CBPeripheralManager!
    private var rxCharacteristic: CBMutableCharacteristic?
    private let reassembler = Reassembler()

    private final class Link {
        let peripheral: CBPeripheral
        var rx: CBCharacteristic?
        var queue: [Data] = []
        var writing = false
        init(peripheral: CBPeripheral) { self.peripheral = peripheral }
    }

    /// Outgoing links (we are central), keyed by peripheral identifier.
    private var links: [UUID: Link] = [:]
    /// Peripherals we recently lost; skip reconnecting for a few seconds.
    private var cooldown: [UUID: Date] = [:]
    private var running = false

    public private(set) var isBluetoothOn = false

    public override init() {
        super.init()
    }

    public func start() {
        guard !running else { return }
        running = true
        central = CBCentralManager(delegate: self, queue: .main)
        peripheralManager = CBPeripheralManager(delegate: self, queue: .main)
    }

    public func stop() {
        running = false
        central?.stopScan()
        links.values.forEach { central?.cancelPeripheralConnection($0.peripheral) }
        links.removeAll()
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
    }

    public var readyPeerCount: Int { links.values.filter { $0.rx != nil }.count }

    // MARK: MeshTransport

    public func send(_ envelopeJSON: Data, to peer: String) {
        guard let uuid = UUID(uuidString: peer), let link = links[uuid], link.rx != nil else { return }
        let maxWrite = link.peripheral.maximumWriteValueLength(for: .withoutResponse)
        let frames = Framing.chunk(envelopeJSON, transferId: UInt32.random(in: .min ... .max), maxWriteLength: maxWrite)
        link.queue.append(contentsOf: frames)
        pump(link)
    }

    private func pump(_ link: Link) {
        guard !link.writing, let rx = link.rx, !link.queue.isEmpty else { return }
        link.writing = true
        link.peripheral.writeValue(link.queue.removeFirst(), for: rx, type: .withResponse)
    }

    private func log(_ s: String) { delegate?.transport(self, log: s) }

    private func startScanning() {
        guard central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [serviceUUID],
                                   options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        log("Scanning for Beacon peers")
    }

    private func dropLink(_ id: UUID, reason: String) {
        guard links.removeValue(forKey: id) != nil else { return }
        cooldown[id] = Date()
        reassembler.reset(peer: id.uuidString)
        log("Peer \(id.uuidString.prefix(8)) lost: \(reason)")
        delegate?.transport(self, peerLost: id.uuidString)
    }
}

// MARK: - Central role

extension BLETransport: CBCentralManagerDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        isBluetoothOn = central.state == .poweredOn
        log("Central state: \(central.state.rawValue)")
        if central.state == .poweredOn {
            startScanning()
        } else {
            Array(links.keys).forEach { dropLink($0, reason: "bluetooth off") }
        }
    }

    public func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let id = peripheral.identifier
        guard links[id] == nil else { return }
        if let lost = cooldown[id], Date().timeIntervalSince(lost) < 5 { return }
        let link = Link(peripheral: peripheral)
        links[id] = link
        peripheral.delegate = self
        log("Found peer \(id.uuidString.prefix(8)) rssi \(RSSI), connecting")
        central.connect(peripheral, options: nil)
        // iOS connection attempts never time out on their own; give up after 10 s so we retry.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, let current = self.links[id], current === link, link.rx == nil else { return }
            self.central.cancelPeripheralConnection(peripheral)
            self.dropLink(id, reason: "connect timeout")
        }
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([serviceUUID])
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        dropLink(peripheral.identifier, reason: "connect failed \(error?.localizedDescription ?? "")")
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                               error: Error?) {
        dropLink(peripheral.identifier, reason: "disconnected")
    }
}

extension BLETransport: CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([rxUUID], for: service)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                           error: Error?) {
        guard let link = links[peripheral.identifier],
              let rx = service.characteristics?.first(where: { $0.uuid == rxUUID })
        else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        link.rx = rx
        log("Peer \(peripheral.identifier.uuidString.prefix(8)) ready (write len \(peripheral.maximumWriteValueLength(for: .withoutResponse)))")
        delegate?.transport(self, peerReady: peripheral.identifier.uuidString)
    }

    public func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
                           error: Error?) {
        guard let link = links[peripheral.identifier] else { return }
        link.writing = false
        if let error { log("Write to \(peripheral.identifier.uuidString.prefix(8)) failed: \(error.localizedDescription)") }
        pump(link)
    }

    public func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        if invalidatedServices.contains(where: { $0.uuid == serviceUUID }) {
            central.cancelPeripheralConnection(peripheral)
        }
    }
}

// MARK: - Peripheral role

extension BLETransport: CBPeripheralManagerDelegate {
    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        log("Peripheral state: \(peripheral.state.rawValue)")
        guard peripheral.state == .poweredOn else { return }
        let rx = CBMutableCharacteristic(type: rxUUID, properties: [.write, .writeWithoutResponse],
                                         value: nil, permissions: [.writeable])
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [rx]
        rxCharacteristic = rx
        peripheral.removeAllServices()
        peripheral.add(service)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            log("Add service failed: \(error.localizedDescription)")
            return
        }
        peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID]])
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        log(error.map { "Advertising failed: \($0.localizedDescription)" } ?? "Advertising Beacon service")
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests where request.characteristic.uuid == rxUUID {
            guard let value = request.value else { continue }
            let peer = request.central.identifier.uuidString
            if let payload = reassembler.ingest(value, from: peer) {
                delegate?.transport(self, received: payload, from: peer)
            }
        }
        if let first = requests.first {
            peripheral.respond(to: first, withResult: .success)
        }
    }
}
