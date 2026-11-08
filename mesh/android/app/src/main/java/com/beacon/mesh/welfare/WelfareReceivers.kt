package com.beacon.mesh.welfare

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.beacon.mesh.MeshNode

/** The three action buttons of the check-in notification. */
class WelfareActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(WelfareIntents.EXTRA_CHECKIN_ID) ?: return
        val response = intent.getStringExtra(WelfareIntents.EXTRA_RESPONSE)?.takeIf { WelfareResponse.isKnown(it) } ?: return
        val pending = goAsync()
        val finish = java.util.concurrent.atomic.AtomicBoolean(false)
        val done = { if (finish.compareAndSet(false, true)) pending.finish() }
        // The process can be frozen right after onReceive: keep the receiver alive until the reply is on its way (max 10 s).
        Handler(Looper.getMainLooper()).postDelayed(done, 9_000)
        MeshNode.get(context).answerCheckin(id, response) { done() }
    }
}

/** Re-posts the open check-in notifications after a reboot or an app update (both clear them). */
class WelfareBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        MeshNode.get(context).welfare.restore()
    }
}
