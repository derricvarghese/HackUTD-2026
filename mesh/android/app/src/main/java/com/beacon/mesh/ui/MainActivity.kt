package com.beacon.mesh.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import android.content.Intent
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.beacon.mesh.welfare.WelfareLaunch

/**
 * Single activity hosting the Compose UI. Edge-to-edge is enabled before content is set; the theme
 * (BeaconTheme) re-applies bar styles when the user overrides light/dark. State lives in
 * [MeshViewModel], so rotation and process death keep the SOS draft and settings.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must run before super.onCreate: swaps Theme.Beacon.Splash for Theme.Beacon after the first frame.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WelfareLaunch.handle(intent)
        setContent { BeaconApp() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        WelfareLaunch.handle(intent)
    }
}
