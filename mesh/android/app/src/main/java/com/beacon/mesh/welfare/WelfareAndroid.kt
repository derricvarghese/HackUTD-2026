package com.beacon.mesh.welfare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.beacon.mesh.R
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.ui.MainActivity
import java.text.DateFormat
import java.util.Date

/** Intent actions / extras shared by the welfare receivers and the notification. */
object WelfareIntents {
    const val EXTRA_CHECKIN_ID = "beacon.checkin_id"
    const val EXTRA_RESPONSE = "beacon.response"
    const val ACTION_ANSWER = "com.beacon.mesh.WELFARE_ANSWER"
    const val ACTION_OPEN = "com.beacon.mesh.WELFARE_OPEN"
}

/** Notification state, for the Mesh status card. */
object WelfarePermissions {
    fun notificationsEnabled(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()
}

/** Posts the check-in notification. Never logs check-in content. */
class AndroidWelfareNotifier(context: Context) : WelfareNotifier {
    private val app = context.applicationContext
    private val nm = NotificationManagerCompat.from(app)

    override fun show(p: CheckinPrompt, nowMs: Long, alert: Boolean) {
        val model = WelfareNotificationModel.build(p, nowMs) ?: return
        ensureChannels(app)
        post(model.notificationId, checkinNotification(model, alert))
    }

    override fun cancel(checkinId: String) {
        nm.cancel(WelfareNotificationModel.idFor(checkinId))
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun post(id: Int, n: Notification) {
        try { if (nm.areNotificationsEnabled()) nm.notify(id, n) } catch (e: SecurityException) { /* POST_NOTIFICATIONS revoked */ }
    }

    private fun answerIntent(checkinId: String, response: String): PendingIntent = PendingIntent.getBroadcast(
        app, 0,
        Intent(app, WelfareActionReceiver::class.java).setAction(WelfareIntents.ACTION_ANSWER)
            .setData(Uri.parse("beacon://welfare/answer/$checkinId/$response"))
            .putExtra(WelfareIntents.EXTRA_CHECKIN_ID, checkinId).putExtra(WelfareIntents.EXTRA_RESPONSE, response),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun openIntent(checkinId: String): PendingIntent = PendingIntent.getActivity(
        app, 0,
        Intent(app, MainActivity::class.java).setAction(WelfareIntents.ACTION_OPEN)
            .setData(Uri.parse("beacon://welfare/open/$checkinId")).putExtra(WelfareIntents.EXTRA_CHECKIN_ID, checkinId)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun label(response: String): String = app.getString(
        when (response) {
            WelfareResponse.NO_LONGER_NEED_HELP -> R.string.welfare_no_longer
            WelfareResponse.NEED_URGENT_HELP -> R.string.welfare_urgent
            else -> R.string.welfare_still_here
        }
    )

    private fun deadlineText(deadlineMs: Long?): String? =
        deadlineMs?.let { app.getString(R.string.welfare_notif_answer_by, DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))) }

    private fun checkinNotification(m: WelfareNotificationModel, alert: Boolean): Notification {
        val b = NotificationCompat.Builder(app, CHANNEL_CHECKIN)
            .setSmallIcon(R.drawable.ic_stat_beacon)
            .setContentTitle(m.title ?: app.getString(R.string.welfare_notif_title))
            .setContentText(
                if (m.overdue) app.getString(R.string.welfare_notif_overdue)
                else listOfNotNull(m.body ?: app.getString(R.string.welfare_notif_body), deadlineText(m.deadlineAtMs)).joinToString(" ")
            )
            .setStyle(NotificationCompat.BigTextStyle())
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setColor(0xFFB3261E.toInt())
            .setOngoing(true)
            .setAutoCancel(false)
            // The same id is re-posted on every reminder: alert again only when asked, otherwise update silently.
            .setOnlyAlertOnce(!alert)
            .setContentIntent(openIntent(m.checkinId))
        m.deadlineAtMs?.let { b.setWhen(it).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true) }
        m.actions.forEach { r -> b.addAction(0, label(r), answerIntent(m.checkinId, r)) }
        return b.build()
    }

    companion object {
        const val CHANNEL_CHECKIN = "beacon_welfare"
        private val CHECKIN_VIBRATION = longArrayOf(0, 600, 250, 600, 250, 900)

        fun ensureChannels(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL_CHECKIN) == null) {
                val ch = NotificationChannel(CHANNEL_CHECKIN, context.getString(R.string.welfare_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.welfare_channel_desc)
                    enableVibration(true); vibrationPattern = CHECKIN_VIBRATION
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setShowBadge(true)
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_REQUEST)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                    )
                }
                nm.createNotificationChannel(ch)
            }
        }
    }
}
