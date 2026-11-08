package com.beacon.mesh.ui

import android.content.Context
import com.beacon.mesh.ui.theme.ThemeMode

/** User-interface settings (not mesh state). Mesh settings stay in [com.beacon.mesh.MeshNode]. */
data class UiSettings(
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = true,
    val onboardingDone: Boolean = false,
    /** Permissions we have already requested once; needed to tell "denied" from "never asked". */
    val askedPermissions: Set<String> = emptySet(),
)

class UiPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("beacon_ui", Context.MODE_PRIVATE)

    fun load() = UiSettings(
        themeMode = runCatching { ThemeMode.valueOf(prefs.getString("theme", null) ?: "SYSTEM") }
            .getOrDefault(ThemeMode.SYSTEM),
        dynamicColor = prefs.getBoolean("dynamic", true),
        onboardingDone = prefs.getBoolean("onboarded", false),
        askedPermissions = prefs.getStringSet("asked", emptySet()).orEmpty().toSet(),
    )

    fun save(s: UiSettings) {
        prefs.edit()
            .putString("theme", s.themeMode.name)
            .putBoolean("dynamic", s.dynamicColor)
            .putBoolean("onboarded", s.onboardingDone)
            .putStringSet("asked", s.askedPermissions)
            .apply()
    }
}
