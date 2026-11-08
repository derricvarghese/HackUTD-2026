package com.beacon.mesh.transport

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import com.beacon.mesh.MeshTransport
import com.beacon.mesh.protocol.MeshProtocol
import java.nio.ByteBuffer
import java.util.UUID
import kotlin.random.Random

/**
 * BLE GATT transport that interoperates with the iOS `BLETransport`.
 *
 * Every phone is both a peripheral (advertises the Beacon service, accepts writes on RX) and a
 * central (scans, connects to every Beacon peer, writes chunks into their RX characteristic).
 * All state is touched only on [main]; binder-thread callbacks are posted there.
 *
 * Callers must hold BLUETOOTH_SCAN / ADVERTISE / CONNECT (Android 12+) or FINE_LOCATION (11-).
 */
@SuppressLint("MissingPermission")
class BleMeshTransport(private val context: Context, private val main: Handler) : MeshTransport {

    interface Listener {
        fun onPeerReady(peer: String)
        fun onPeerLost(peer: String)
        fun onEnvelope(envelopeJson: ByteArray, fromPeer: String)
        fun onLog(message: String)
    }

    var listener: Listener? = null

    private val manager: BluetoothManager? = context.getSystemService(BluetoothManager::class.java)
    private val reassembler = Reassembler()
    private var gattServer: BluetoothGattServer? = null
    private var running = false

    companion object {
        /** Read-only characteristic holding the 16 raw bytes (big-endian) of the phone's instance UUID. */
        val ID_CHARACTERISTIC_UUID: UUID = UUID.fromString("B5A10003-7E4C-4C3A-9D2F-6B8E1C0FBEAC")
        /** Single-chunk frame: type byte 0x02 followed by the sender's 16-byte instance UUID. */
        const val FRAME_TYPE_HELLO: Byte = 0x02
        private const val MAX_ATTRIBUTE_LEN = 512
    }

    /**
     * Stable identity of this app install, kept in its own preferences file so it survives restarts.
     * Peers read it from [ID_CHARACTERISTIC_UUID] and use it instead of the (rotating) BLE address.
     */
    var instanceId: String = loadOrCreateInstanceId()
        private set
    private var registry = PeerRegistry(instanceId)
    /** Inbound writers (phones that connected to our GATT server) that said hello: address -> phone id. */
    private val inboundIds = HashMap<String, String>()

    private fun loadOrCreateInstanceId(): String {
        val prefs = context.getSharedPreferences("beacon_instance", Context.MODE_PRIVATE)
        prefs.getString("id", null)?.let { return it }
        val fresh = UUID.randomUUID().toString().lowercase()
        prefs.edit().putString("id", fresh).apply()
        return fresh
    }

    /**
     * New persistent instance UUID (demo "Reset device identity"): stops the transport, forgets every link, then restarts it
     * (when it was running) so the phone re-advertises and reconnects under the new id.
     */
    fun regenerateInstanceId(): String {
        val wasRunning = running
        if (wasRunning) stop()
        val fresh = UUID.randomUUID().toString().lowercase()
        context.getSharedPreferences("beacon_instance", Context.MODE_PRIVATE).edit().putString("id", fresh).apply()
        instanceId = fresh
        registry = PeerRegistry(fresh)
        inboundIds.clear()
        // Give the BLE stack a moment to release the old GATT server / advertiser before starting again.
        if (wasRunning) main.postDelayed({ if (!running) start() }, 600)
        return fresh
    }

    private fun idBytes(): ByteArray {
        val u = UUID.fromString(instanceId)
        return ByteBuffer.allocate(16).putLong(u.mostSignificantBits).putLong(u.leastSignificantBits).array()
    }

    private fun idFromBytes(b: ByteArray): String? {
        if (b.size != 16) return null
        val buf = ByteBuffer.wrap(b)
        return UUID(buf.long, buf.long).toString().lowercase()
    }

    private class Link(val address: String) {
        var gatt: BluetoothGatt? = null
        var rx: BluetoothGattCharacteristic? = null
        var idChar: BluetoothGattCharacteristic? = null
        /** Phone id once identified; null while the link is still being set up. */
        var peerId: String? = null
        var mtu = 23
        val queue = ArrayDeque<ByteArray>()
        var writing = false
        var retries = 0
    }

    /** Outgoing links (we are central), keyed by MAC address. */
    private val links = HashMap<String, Link>()
    private val cooldownUntil = HashMap<String, Long>()

    val readyPeerCount: Int get() = registry.count

    val isBluetoothOn: Boolean get() = manager?.adapter?.isEnabled == true

    fun start() {
        if (running) return
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            log("Bluetooth is off or unavailable")
            return
        }
        running = true
        startGattServer()
        startAdvertising()
        startScanning()
    }

    fun stop() {
        running = false
        manager?.adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
        links.values.forEach { it.gatt?.disconnect(); it.gatt?.close() }
        links.clear()
        registry.clear()
        inboundIds.clear()
        gattServer?.close()
        gattServer = null
    }

    // ---- MeshTransport ----

    override fun send(envelopeJson: ByteArray, peer: String) {
        val link = links[registry.addressFor(peer) ?: peer]
        if (link == null || link.rx == null || link.peerId == null) {
            log("TX to $peer skipped: no ready link (links=${links.keys})")
            return
        }
        // An ATT attribute value is at most 512 bytes: with MTU 517, mtu-3 = 514 makes writeCharacteristic throw.
        val frames = Framing.chunk(envelopeJson, Random.nextInt(), minOf(link.mtu - 3, MAX_ATTRIBUTE_LEN))
        log("TX ${envelopeJson.size} B in ${frames.size} frame(s) to $peer (mtu ${link.mtu})")
        link.queue.addAll(frames)
        pump(link)
    }

    private fun pump(link: Link) {
        if (link.writing) return
        val gatt = link.gatt ?: return
        val rx = link.rx ?: return
        val frame = link.queue.firstOrNull() ?: return
        link.writing = true
        val ok = if (Build.VERSION.SDK_INT >= 33) {
            gatt.writeCharacteristic(rx, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) ==
                BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            rx.value = frame
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(rx)
        }
        if (!ok) {
            // The stack is busy; retry shortly, give up on this frame after a few tries.
            link.writing = false
            if (++link.retries > 5) {
                link.queue.removeFirstOrNull()
                link.retries = 0
                log("Write to ${link.address} failed, dropping frame")
            }
            main.postDelayed({ if (links[link.address] === link) pump(link) }, 100)
        }
    }

    private fun onWriteComplete(link: Link, status: Int) {
        link.writing = false
        link.queue.removeFirstOrNull()
        link.retries = 0
        if (status != BluetoothGatt.GATT_SUCCESS) log("Write to ${link.address} status $status")
        else if (link.queue.isEmpty()) log("TX to ${link.address} complete")
        pump(link)
    }

    // ---- Peripheral role: GATT server + advertising ----

    private fun startGattServer() {
        val server = manager?.openGattServer(context, serverCallback) ?: run {
            log("Could not open GATT server")
            return
        }
        val rx = BluetoothGattCharacteristic(
            MeshProtocol.RX_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        val idChar = BluetoothGattCharacteristic(
            ID_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        val service = BluetoothGattService(MeshProtocol.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(rx)
        service.addCharacteristic(idChar)
        server.addService(service)
        gattServer = server
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            val state = if (newState == BluetoothProfile.STATE_CONNECTED) "connected" else "disconnected"
            if (newState != BluetoothProfile.STATE_CONNECTED) main.post { inboundIds.remove(device.address) }
            main.post { log("Inbound ${device.address} $state") }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic,
        ) {
            if (characteristic.uuid != ID_CHARACTERISTIC_UUID) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, 0, null)
                return
            }
            val id = idBytes()
            val slice = if (offset >= id.size) ByteArray(0) else id.copyOfRange(offset, id.size)
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
            main.post { log("Inbound write ${value?.size ?: -1} B from ${device.address} (prepared=$preparedWrite)") }
            if (characteristic.uuid != MeshProtocol.RX_CHARACTERISTIC_UUID || value == null) return
            if (preparedWrite) {
                main.post { log("Ignoring long write from ${device.address}") }
                return
            }
            val frame = value.copyOf()
            val address = device.address
            main.post {
                if (frame.size == 1 + 16 && frame[0] == FRAME_TYPE_HELLO) {
                    idFromBytes(frame.copyOfRange(1, frame.size))?.let {
                        inboundIds[address] = it
                        log("Inbound hello from ${it.take(8)} ($address)")
                    }
                    return@post
                }
                // Prefer the sender's stable id so the router never echoes a message back to its source.
                val peer = inboundIds[address] ?: registry.idFor(address) ?: "in:$address"
                val whole = reassembler.ingest(frame, peer)
                if (whole == null) log("Inbound frame from $peer buffered or invalid (${frame.size} B)")
                whole?.let { listener?.onEnvelope(it, peer) }
            }
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
        }
    }

    private fun startAdvertising() {
        val advertiser = manager?.adapter?.bluetoothLeAdvertiser ?: run {
            log("This phone cannot advertise BLE (peripheral mode unsupported)")
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(MeshProtocol.SERVICE_UUID))
            .build()
        advertiser.startAdvertising(settings, data, advertiseCallback)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            main.post { log("Advertising Beacon service") }
        }

        override fun onStartFailure(errorCode: Int) {
            main.post { log("Advertising failed: $errorCode") }
        }
    }

    // ---- Central role: scan + connect + write ----

    private fun startScanning() {
        val scanner = manager?.adapter?.bluetoothLeScanner ?: return
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(MeshProtocol.SERVICE_UUID)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(listOf(filter), settings, scanCallback)
        log("Scanning for Beacon peers")
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val rssi = result.rssi
            main.post { maybeConnect(device, rssi) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { r -> main.post { maybeConnect(r.device, r.rssi) } }
        }

        override fun onScanFailed(errorCode: Int) {
            main.post { log("Scan failed: $errorCode") }
        }
    }

    private fun maybeConnect(device: BluetoothDevice, rssi: Int) {
        if (!running) return
        val address = device.address
        if (links.containsKey(address)) return
        if ((cooldownUntil[address] ?: 0L) > System.currentTimeMillis()) return
        val link = Link(address)
        links[address] = link
        log("Found peer $address rssi $rssi, connecting")
        link.gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        main.postDelayed({
            if (links[address] === link && link.peerId == null) dropLink(address, "connect timeout")
        }, 10_000)
    }

    private fun dropLink(address: String, reason: String, cooldownMs: Long = 5_000) {
        val link = links.remove(address) ?: return
        link.gatt?.disconnect()
        link.gatt?.close()
        cooldownUntil[address] = System.currentTimeMillis() + cooldownMs
        reassembler.reset(address)
        val id = registry.release(address)
        reassembler.reset(id ?: address)
        if (id != null && link.peerId == id) {
            log("Peer ${id.take(8)} lost: $reason")
            listener?.onPeerLost(id)
        } else {
            log("Link $address dropped: $reason")
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            main.post {
                val link = links[address] ?: run { gatt.close(); return@post }
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    link.gatt = gatt
                    if (!gatt.requestMtu(517)) gatt.discoverServices()
                } else {
                    dropLink(address, "state $newState status $status")
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val address = gatt.device.address
            main.post {
                val link = links[address] ?: return@post
                if (status == BluetoothGatt.GATT_SUCCESS) link.mtu = mtu
                gatt.discoverServices()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val address = gatt.device.address
            main.post {
                val link = links[address] ?: return@post
                val rx = gatt.getService(MeshProtocol.SERVICE_UUID)
                    ?.getCharacteristic(MeshProtocol.RX_CHARACTERISTIC_UUID)
                if (rx == null) {
                    dropLink(address, "no Beacon service")
                    return@post
                }
                link.rx = rx
                val idChar = gatt.getService(MeshProtocol.SERVICE_UUID)?.getCharacteristic(ID_CHARACTERISTIC_UUID)
                if (idChar == null) {
                    // Older build without the id characteristic: fall back to address identity.
                    identified(link, PeerRegistry.legacyId(address))
                } else {
                    link.idChar = idChar
                    if (!gatt.readCharacteristic(idChar)) identified(link, PeerRegistry.legacyId(address))
                }
            }
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            handleIdRead(gatt.device.address, characteristic, value, status)
        }

        @Deprecated("Used on Android 12 and lower")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) handleIdRead(gatt.device.address, characteristic, characteristic.value ?: ByteArray(0), status)
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            val address = gatt.device.address
            main.post { links[address]?.let { onWriteComplete(it, status) } }
        }
    }

    private fun handleIdRead(address: String, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
        if (characteristic.uuid != ID_CHARACTERISTIC_UUID) return
        val copy = value.copyOf()
        main.post {
            val link = links[address] ?: return@post
            if (link.peerId != null) return@post
            val id = if (status == BluetoothGatt.GATT_SUCCESS) idFromBytes(copy) else null
            identified(link, id ?: PeerRegistry.legacyId(address))
        }
    }

    /** The peer's stable id is known: keep one link per phone, drop duplicates and ourselves. */
    private fun identified(link: Link, id: String) {
        when (val d = registry.identify(link.address, id)) {
            PeerRegistry.Decision.Self -> dropLink(link.address, "that is this phone", cooldownMs = 120_000)
            is PeerRegistry.Decision.Duplicate -> {
                log("Ignoring ${link.address}: already linked to ${d.id.take(8)} via ${d.existingAddress}")
                dropLink(link.address, "duplicate of ${d.id.take(8)}", cooldownMs = 60_000)
            }
            is PeerRegistry.Decision.Accept -> {
                link.peerId = d.id
                log("Peer ${d.id.take(8)} ready (${link.address}, mtu ${link.mtu})")
                // Tell the other side who we are, so its router can tell our messages apart from echoes.
                link.queue.addFirst(byteArrayOf(FRAME_TYPE_HELLO) + idBytes())
                pump(link)
                listener?.onPeerReady(d.id)
            }
        }
    }

    private fun log(message: String) {
        listener?.onLog(message)
    }
}
