package com.beacon.mesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Foreground service so the phone keeps relaying with the screen off. */
class MeshService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)!!
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Beacon mesh relay", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("Beacon is relaying SOS messages")
            .setContentText("Bluetooth mesh active. Relay ID ${MeshNode.get(this).relayId}")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        MeshNode.get(this).start()
        return START_STICKY
    }

    companion object {
        private const val CHANNEL = "beacon_mesh"
        private const val NOTIFICATION_ID = 1
    }
}
