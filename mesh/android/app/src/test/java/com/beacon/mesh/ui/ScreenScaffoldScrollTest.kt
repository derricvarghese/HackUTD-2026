package com.beacon.mesh.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.theme.BeaconTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Regression: a ScreenScaffold with no title (Home) must not install the app-bar scroll connection, or content cannot scroll. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h640dp")
class ScreenScaffoldScrollTest {
    @get:Rule val rule = createComposeRule()

    @Test fun contentScrollsWhenThereIsNoTitle() {
        rule.setContent {
            BeaconTheme(dynamicColor = false) {
                ScreenScaffold(title = null) { pad ->
                    ScrollColumn(pad) {
                        Text("first")
                        repeat(30) { Text("row $it"); Spacer(Modifier.height(40.dp)) }
                        Text("last")
                    }
                }
            }
        }
        val before = rule.onNodeWithText("first").getBoundsInRoot().top
        rule.onNodeWithText("first").assertIsDisplayed()
        rule.onNodeWithText("row 0").performTouchInput { swipeUp() }
        rule.waitForIdle()
        val after = rule.onNodeWithText("first").getBoundsInRoot().top
        assertTrue("content did not move: $before -> $after", after < before)
        rule.onNodeWithText("last").performScrollTo().assertIsDisplayed()
    }
}
