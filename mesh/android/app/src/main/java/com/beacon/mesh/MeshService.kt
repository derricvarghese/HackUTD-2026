package com.beacon.mesh

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.beacon.mesh.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** Foreground service so the phone keeps relaying with the screen off. Shows an ongoing notification. */
class MeshService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watcher: Job? = null
    private var ticker: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        val node = MeshNode.get(this)
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(node.relayId, node.peerCount),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0,
        )
        node.start()
        if (watcher == null) {
            // Keep the "N phones nearby" text current without waking the UI.
            watcher = scope.launch {
                node.state.map { it.peers.size }.distinctUntilChanged().collect { n ->
                    getSystemService(NotificationManager::class.java)
                        ?.notify(NOTIFICATION_ID, buildNotification(node.relayId, n))
                }
            }
        }
        if (ticker == null) {
            // Heartbeats, outbox/status polling and server-info refresh run here so they work with the screen off.
            ticker = scope.launch {
                while (true) {
                    try { node.tick() } catch (e: Exception) { /* never let a bad tick kill the service */ }
                    delay(TICK_MS)
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun ensureChannel() {
        val channel = NotificationChannel(CHANNEL, getString(R.string.notif_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun buildNotification(relayId: String, peers: Int): android.app.Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_beacon)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(resources.getQuantityString(R.plurals.notif_text, peers, peers, relayId))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setColor(0xFFB3261E.toInt())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .addAction(0, getString(R.string.notif_action_open), open)
            .build()
    }

    companion object {
        private const val CHANNEL = "beacon_mesh"
        private const val NOTIFICATION_ID = 1
        private const val TICK_MS = 30_000L
    }
}
