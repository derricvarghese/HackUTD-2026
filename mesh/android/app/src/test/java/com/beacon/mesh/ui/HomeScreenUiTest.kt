package com.beacon.mesh.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.ui.screens.HomeScreen
import com.beacon.mesh.ui.theme.BeaconTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Compose UI test on the JVM (Robolectric): the four big SOS buttons exist and report taps. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h640dp")
class HomeScreenUiTest {
    @get:Rule val rule = createComposeRule()

    @Test fun sosTilesAreShownAndClickable() {
        val ready = SystemStatus(
            granted = setOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT"),
            bluetoothOn = true, locationOn = true, sdk = 34,
        )
        val tapped = mutableListOf<Category>()
        rule.setContent {
            BeaconTheme(dynamicColor = false) {
                HomeScreen(MeshSnapshot(relayId = "A1B7"), emptyList(), ready, { tapped += it }, {}, {}, {})
            }
        }
        rule.onNodeWithText("Injured").assertIsDisplayed().performClick()
        rule.onNodeWithText("Trapped").performClick()
        assertEquals(listOf(Category.INJURED, Category.TRAPPED), tapped)
        rule.onNodeWithText("Looking for nearby phones").assertIsDisplayed()
    }
}
