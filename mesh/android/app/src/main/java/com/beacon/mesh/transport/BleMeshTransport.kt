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

    private class Link(val address: String) {
        var gatt: BluetoothGatt? = null
        var rx: BluetoothGattCharacteristic? = null
        var mtu = 23
        val queue = ArrayDeque<ByteArray>()
        var writing = false
        var retries = 0
    }

    /** Outgoing links (we are central), keyed by MAC address. */
    private val links = HashMap<String, Link>()
    private val cooldownUntil = HashMap<String, Long>()

    val readyPeerCount: Int get() = links.values.count { it.rx != null }

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
        gattServer?.close()
        gattServer = null
    }

    // ---- MeshTransport ----

    override fun send(envelopeJson: ByteArray, peer: String) {
        val link = links[peer] ?: return
        if (link.rx == null) return
        val frames = Framing.chunk(envelopeJson, Random.nextInt(), link.mtu - 3)
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
        val service = BluetoothGattService(MeshProtocol.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(rx)
        server.addService(service)
        gattServer = server
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            val state = if (newState == BluetoothProfile.STATE_CONNECTED) "connected" else "disconnected"
            main.post { log("Inbound ${device.address} $state") }
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
            if (characteristic.uuid != MeshProtocol.RX_CHARACTERISTIC_UUID || value == null) return
            if (preparedWrite) {
                main.post { log("Ignoring long write from ${device.address}") }
                return
            }
            val frame = value.copyOf()
            val peer = device.address
            main.post {
                reassembler.ingest(frame, peer)?.let { listener?.onEnvelope(it, peer) }
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
            if (links[address] === link && link.rx == null) dropLink(address, "connect timeout")
        }, 10_000)
    }

    private fun dropLink(address: String, reason: String) {
        val link = links.remove(address) ?: return
        link.gatt?.disconnect()
        link.gatt?.close()
        cooldownUntil[address] = System.currentTimeMillis() + 5_000
        reassembler.reset(address)
        log("Peer $address lost: $reason")
        listener?.onPeerLost(address)
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
                log("Peer $address ready (mtu ${link.mtu})")
                listener?.onPeerReady(address)
            }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            val address = gatt.device.address
            main.post { links[address]?.let { onWriteComplete(it, status) } }
        }
    }

    private fun log(message: String) {
        listener?.onLog(message)
    }
}
