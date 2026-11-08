package com.beacon.mesh.welfare

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Which check-in the in-app confirmation screen should show (set from the notification's content intent or the Home card). */
object WelfareLaunch {
    private val _requested = MutableStateFlow<String?>(null)
    val requested: StateFlow<String?> = _requested.asStateFlow()

    fun open(checkinId: String) { _requested.value = checkinId }
    fun close() { _requested.value = null }

    fun handle(intent: Intent?) {
        if (intent?.action == WelfareIntents.ACTION_OPEN) intent.getStringExtra(WelfareIntents.EXTRA_CHECKIN_ID)?.let(::open)
    }
}
