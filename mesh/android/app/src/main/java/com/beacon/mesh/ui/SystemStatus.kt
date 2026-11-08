package com.beacon.mesh.ui

import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.beacon.mesh.ui.logic.PermGroup
import com.beacon.mesh.ui.logic.PermissionPlan

/** Snapshot of runtime permissions and the two system toggles (Bluetooth, location services). */
data class SystemStatus(
    val granted: Set<String> = emptySet(),
    val rationale: Set<String> = emptySet(),
    val bluetoothOn: Boolean = false,
    val locationOn: Boolean = false,
    val sdk: Int = Build.VERSION.SDK_INT,
) {
    private fun has(group: PermGroup, any: Boolean = false): Boolean {
        val p = PermissionPlan.permissions(group, sdk)
        return p.isEmpty() || if (any) p.any { it in granted } else p.all { it in granted }
    }

    val bluetoothPermission get() = has(PermGroup.BLUETOOTH)
    val locationPermission get() = has(PermGroup.LOCATION, any = true)
    val notificationsPermission get() = has(PermGroup.NOTIFICATIONS)

    val readiness
        get() = PermissionPlan.Readiness(bluetoothPermission, locationPermission, bluetoothOn, locationOn, sdk)
}

fun readSystemStatus(context: Context, activity: Activity?): SystemStatus {
    val sdk = Build.VERSION.SDK_INT
    val all = PermGroup.entries.flatMap { PermissionPlan.permissions(it, sdk) }
    val granted = all.filter {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }.toSet()
    val rationale = if (activity == null) emptySet() else all.filter {
        activity.shouldShowRequestPermissionRationale(it)
    }.toSet()
    val bt = context.getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true
    val lm = context.getSystemService(LocationManager::class.java)
    val loc = lm != null && LocationManagerCompat.isLocationEnabled(lm)
    return SystemStatus(granted, rationale, bt, loc, sdk)
}

/** Live [SystemStatus] with an explicit [refresh] for use right after a permission result. */
@Stable
class SystemStatusHolder internal constructor(private val read: () -> SystemStatus) {
    var status by mutableStateOf(read())
        private set

    fun refresh() { status = read() }
}

/** Refreshed on resume (after returning from settings) and on Bluetooth / location toggles. */
@Composable
fun rememberSystemStatus(): SystemStatusHolder {
    val context = LocalContext.current
    val activity = LocalActivity.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val holder = remember { SystemStatusHolder { readSystemStatus(context, activity) } }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) holder.refresh() }
        lifecycle.addObserver(observer)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) = holder.refresh()
        }
        val filter = IntentFilter().apply {
            addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
            addAction(LocationManager.PROVIDERS_CHANGED_ACTION)
            addAction("android.location.MODE_CHANGED")
        }
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        onDispose {
            lifecycle.removeObserver(observer)
            context.unregisterReceiver(receiver)
        }
    }
    return holder
}

object SystemIntents {
    fun appSettings(context: Context) = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun bluetoothSettings() = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    fun locationSettings() = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** System dialog "Turn on Bluetooth?" (needs BLUETOOTH_CONNECT on Android 12+). */
    fun enableBluetooth() = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)

    fun appLanguage(context: Context): Intent? =
        if (Build.VERSION.SDK_INT >= 33) {
            Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.fromParts("package", context.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else null

    fun notificationSettings(context: Context) = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

fun Context.safeStart(intent: Intent) {
    try { startActivity(intent) } catch (_: Exception) { /* no handler on this device */ }
}
