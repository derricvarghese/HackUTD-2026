package com.beacon.mesh.ui.preview

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.material3.Surface
import androidx.compose.material3.MaterialTheme
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.GpsFix
import com.beacon.mesh.ui.SystemStatus
import com.beacon.mesh.ui.screens.HomeScreen
import com.beacon.mesh.ui.screens.MeshStatusScreen
import com.beacon.mesh.ui.screens.SettingsScreen
import com.beacon.mesh.ui.UiSettings
import com.beacon.mesh.ui.theme.BeaconTheme
import com.beacon.mesh.ui.theme.ThemeMode

private val ReadySystem = SystemStatus(
    granted = setOf(
        "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE",
        "android.permission.BLUETOOTH_CONNECT", "android.permission.ACCESS_FINE_LOCATION",
    ),
    bluetoothOn = true, locationOn = true, sdk = 34,
)
private val Mesh = MeshSnapshot(relayId = "A1B7", started = true, peers = listOf("AA:BB:CC:DD:EE:01"), gps = GpsFix(12f, 0L))

@Composable
private fun Host(dark: Boolean = false, content: @Composable () -> Unit) {
    BeaconTheme(if (dark) ThemeMode.DARK else ThemeMode.LIGHT, dynamicColor = false) {
        Surface(color = MaterialTheme.colorScheme.background, content = content)
    }
}

@Composable private fun Home() = HomeScreen(Mesh, emptyList(), ReadySystem, {}, {}, {}, {})

@Preview(name = "Compact", widthDp = 360, heightDp = 640, showBackground = true)
@Composable fun HomeCompactPreview() = Host { Home() }

@Preview(name = "Expanded tablet", widthDp = 1024, heightDp = 700, showBackground = true)
@Composable fun HomeExpandedPreview() = Host { Home() }

@Preview(name = "Dark", widthDp = 360, heightDp = 640, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true)
@Composable fun HomeDarkPreview() = Host(dark = true) { Home() }

@Preview(name = "Font 200%", widthDp = 360, heightDp = 640, fontScale = 2f, showBackground = true)
@Composable fun HomeLargeFontPreview() = Host { Home() }

@Preview(name = "Landscape", widthDp = 800, heightDp = 360, showBackground = true)
@Composable fun HomeLandscapePreview() = Host { Home() }

@Preview(name = "Mesh status 200%", widthDp = 360, heightDp = 640, fontScale = 2f, showBackground = true)
@Composable fun MeshLargeFontPreview() = Host { MeshStatusScreen(Mesh, emptyList(), ReadySystem) }

@Preview(name = "Settings dark", widthDp = 360, heightDp = 640, showBackground = true)
@Composable fun SettingsDarkPreview() = Host(dark = true) {
    SettingsScreen(UiSettings(), Mesh, ReadySystem, {}, {}, {})
}
