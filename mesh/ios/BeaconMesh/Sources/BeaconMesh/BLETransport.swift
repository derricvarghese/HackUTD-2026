#if canImport(CoreBluetooth)
import CoreBluetooth
import Foundation

public protocol BLETransportDelegate: AnyObject {
    func transport(_ transport: BLETransport, peerReady peer: String)
    func transport(_ transport: BLETransport, peerLost peer: String)
    func transport(_ transport: BLETransport, received json: Data, from peer: String)
    func transport(_ transport: BLETransport, log message: String)
}

/// BLE GATT transport that interoperates with the Android `BleMeshTransport`.
///
/// Every phone is both a peripheral (advertises the Beacon service, accepts writes on RX, exposes its instance id on the
/// read-only ID characteristic) and a central (scans, connects to every Beacon peer, reads its id, says HELLO, writes
/// chunks to its RX). Peers are identified by the persistent instance UUID, never by the rotating BLE identifier, and
/// `PeerRegistry` keeps exactly one link per phone. All CoreBluetooth callbacks run on the main queue.
public final class BLETransport: NSObject, MeshTransport {
    public weak var delegate: BLETransportDelegate?

    /// Stable identity of this install (lowercase UUID string).
    public let instanceId: String

    private let serviceUUID = CBUUID(string: MeshProtocol.serviceUUID)
    private let rxUUID = CBUUID(string: MeshProtocol.rxCharacteristicUUID)
    private let idUUID = CBUUID(string: InstanceId.characteristicUUID)

    private var central: CBCentralManager!
    private var peripheralManager: CBPeripheralManager!
    private var rxCharacteristic: CBMutableCharacteristic?
    private let reassembler = Reassembler()
    private let registry: PeerRegistry

    private final class Link {
        let peripheral: CBPeripheral
        var rx: CBCharacteristic?
        var idChar: CBCharacteristic?
        /// Phone id once identified; nil while the link is still being set up.
        var peerId: String?
        var queue: [Data] = []
        var writing = false
        init(peripheral: CBPeripheral) { self.peripheral = peripheral }
    }

    /// Outgoing links (we are central), keyed by peripheral identifier.
    private var links: [UUID: Link] = [:]
    /// Peripherals we must not reconnect to until the given time.
    private var cooldownUntil: [UUID: Date] = [:]
    /// Inbound writers (centrals connected to our GATT server) that said hello: central identifier -> phone id.
    private var inboundIds: [UUID: String] = [:]
    private var running = false

    public private(set) var isBluetoothOn = false

    public override init() {
        let id = InstanceId.loadOrCreate()
        instanceId = id
        registry = PeerRegistry(ownId: id)
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
        registry.clear()
        inboundIds.removeAll()
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
    }

    /// Distinct phones with a ready outbound link.
    public var readyPeerCount: Int { registry.count }

    // MARK: MeshTransport

    /// `peer` is a phone id from `peerReady`.
    public func send(_ json: Data, to peer: String) {
        guard let address = registry.addressFor(id: peer), let uuid = UUID(uuidString: address),
              let link = links[uuid], link.rx != nil else { return }
        let maxWrite = link.peripheral.maximumWriteValueLength(for: .withResponse)
        let frames = Framing.chunk(json, transferId: UInt32.random(in: .min ... .max), maxWriteLength: maxWrite)
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

    private func dropLink(_ id: UUID, reason: String, cooldown: TimeInterval = 5) {
        guard let link = links.removeValue(forKey: id) else { return }
        cooldownUntil[id] = Date().addingTimeInterval(cooldown)
        if link.peerId != nil || registry.idFor(address: id.uuidString) != nil {
            if let phone = registry.release(address: id.uuidString) {
                reassembler.reset(peer: phone)
                log("Peer \(phone.prefix(8)) lost: \(reason)")
                delegate?.transport(self, peerLost: phone)
            }
        } else {
            log("Link \(id.uuidString.prefix(8)) dropped: \(reason)")
        }
    }

    /// The peer's stable id is known: keep one link per phone, drop duplicates and ourselves.
    private func identified(_ link: Link, id: String) {
        let address = link.peripheral.identifier
        switch registry.identify(address: address.uuidString, id: id) {
        case .selfId:
            central.cancelPeripheralConnection(link.peripheral)
            dropLink(address, reason: "that is this phone", cooldown: 120)
        case .duplicate(let phone, let existing):
            log("Ignoring \(address.uuidString.prefix(8)): already linked to \(phone.prefix(8)) via \(existing.prefix(8))")
            central.cancelPeripheralConnection(link.peripheral)
            dropLink(address, reason: "duplicate of \(phone.prefix(8))", cooldown: 60)
        case .accept(let phone):
            link.peerId = phone
            log("Peer \(phone.prefix(8)) ready (write len \(link.peripheral.maximumWriteValueLength(for: .withResponse)))")
            // Tell the other side who we are so its router can tell our messages from echoes.
            if let hello = InstanceId.helloFrame(for: instanceId) { link.queue.insert(hello, at: 0) }
            pump(link)
            delegate?.transport(self, peerReady: phone)
        }
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
        if let until = cooldownUntil[id], Date() < until { return }
        let link = Link(peripheral: peripheral)
        links[id] = link
        peripheral.delegate = self
        log("Found peer \(id.uuidString.prefix(8)) rssi \(RSSI), connecting")
        central.connect(peripheral, options: nil)
        // iOS connection attempts never time out on their own; give up after 10 s so we retry.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, let current = self.links[id], current === link, link.peerId == nil else { return }
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
        peripheral.discoverCharacteristics([rxUUID, idUUID], for: service)
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
        if let idChar = service.characteristics?.first(where: { $0.uuid == idUUID }) {
            link.idChar = idChar
            peripheral.readValue(for: idChar)       // result arrives in didUpdateValueFor
        } else {
            // Older build without the id characteristic: fall back to identifier identity.
            identified(link, id: PeerRegistry.legacyId(peripheral.identifier.uuidString))
        }
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == idUUID, let link = links[peripheral.identifier], link.peerId == nil else { return }
        let id = error == nil ? characteristic.value.flatMap(InstanceId.id(fromBytes:)) : nil
        identified(link, id: id ?? PeerRegistry.legacyId(peripheral.identifier.uuidString))
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
        // Static value (16 raw bytes, RFC 4122 order), so it must be given at creation and cannot change.
        let idChar = CBMutableCharacteristic(type: idUUID, properties: [.read],
                                             value: InstanceId.bytes(of: instanceId), permissions: [.readable])
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [rx, idChar]
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
            let central = request.central.identifier
            if let phone = InstanceId.parseHello(value) {
                inboundIds[central] = phone
                log("Inbound hello from \(phone.prefix(8))")
                continue                     // HELLO never goes to the reassembler
            }
            // Prefer the sender's stable id so the router never echoes a message back to its source.
            let peer = inboundIds[central] ?? registry.idFor(address: central.uuidString) ?? "in:\(central.uuidString)"
            if let payload = reassembler.ingest(value, from: peer) {
                delegate?.transport(self, received: payload, from: peer)
            }
        }
        if let first = requests.first {
            peripheral.respond(to: first, withResult: .success)
        }
    }
}
#endif
