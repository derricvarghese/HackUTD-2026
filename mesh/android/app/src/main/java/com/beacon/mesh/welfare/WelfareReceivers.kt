package com.beacon.mesh.welfare

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.beacon.mesh.MeshNode

/** Re-posts the open check-in notifications after a reboot or an app update (both clear them). */
class WelfareBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        MeshNode.get(context).welfare.restore()
    }
}
