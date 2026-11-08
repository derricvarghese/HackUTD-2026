package com.beacon.mesh.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The real tab logic ([TabNav]) on a real NavHost shaped like the app's graph: Home, Messages, Mesh, Settings,
 * and the secondary routes Profile (opened from Home or Settings) and Debug (from Settings).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h640dp")
class TabNavigationTest {
    @get:Rule val rule = createComposeRule()
    private lateinit var nav: NavHostController
    private val guard = LeaveGuard()
    private val tabs = listOf(Routes.HOME, Routes.MESSAGES, Routes.MESH, Routes.SETTINGS)

    private fun setUp(onProfile: @Composable () -> Unit = {}) {
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.HOME) { Text("home") }
                composable(Routes.MESSAGES) { Text("messages") }
                composable(Routes.MESH) { Text("mesh") }
                composable(Routes.SETTINGS) { Text("settings") }
                composable(Routes.PROFILE) { Text("profile"); onProfile() }
                composable(Routes.DEBUG) { Text("debug") }
            }
        }
    }

    private fun open(route: String) { rule.runOnUiThread { nav.navigate(route) }; rule.waitForIdle() }
    private fun tap(route: String) { rule.runOnUiThread { guard.request { TabNav.goTop(nav, route) } }; rule.waitForIdle() }
    private val top get() = nav.currentDestination?.route
    private fun stack() = nav.currentBackStack.value.mapNotNull { it.destination.route }.filter { it in tabs || it == Routes.PROFILE || it == Routes.DEBUG }
    private fun selected() = TabNav.selectedTab(stack(), tabs)

    @Test fun homeTabReturnsHomeFromProfileOpenedOnHome() {
        setUp()
        open(Routes.PROFILE)
        assertEquals(Routes.PROFILE, top)
        assertEquals("profile opened from Home keeps Home selected", Routes.HOME, selected())
        tap(Routes.HOME)
        assertEquals(Routes.HOME, top)
        assertEquals(listOf(Routes.HOME), stack())
    }

    @Test fun homeTabWorksAgainAfterVisitingOtherTabsWithProfileOpen() {
        setUp()
        open(Routes.PROFILE)
        tap(Routes.MESSAGES)            // used to save [Profile] under Home
        assertEquals(Routes.MESSAGES, top)
        tap(Routes.HOME)                // used to restore Profile on top of Home
        assertEquals(Routes.HOME, top)
        tap(Routes.SETTINGS); tap(Routes.HOME)
        assertEquals(Routes.HOME, top)
        assertEquals(listOf(Routes.HOME), stack())
    }

    @Test fun everyTabRootIsReachableFromEverySecondaryScreen() {
        setUp()
        for (tab in tabs) {
            open(Routes.PROFILE)
            tap(tab)
            assertEquals("from Profile to $tab", tab, top)
        }
        tap(Routes.SETTINGS); open(Routes.DEBUG)
        assertEquals(Routes.SETTINGS, selected())
        for (tab in tabs) {
            tap(Routes.SETTINGS); open(Routes.DEBUG)
            tap(tab)
            assertEquals("from Debug to $tab", tab, top)
        }
    }

    @Test fun retappingTheSelectedTabPopsToItsRoot() {
        setUp()
        tap(Routes.SETTINGS); open(Routes.PROFILE); open(Routes.DEBUG)
        assertEquals(Routes.DEBUG, top)
        tap(Routes.SETTINGS)
        assertEquals(Routes.SETTINGS, top)
        assertEquals(listOf(Routes.HOME, Routes.SETTINGS), stack())
        tap(Routes.SETTINGS)            // already at the root: no-op, no duplicate entry
        assertEquals(listOf(Routes.HOME, Routes.SETTINGS), stack())
        // Profile from Settings: Settings stays selected; re-tap pops to the Settings root.
        open(Routes.PROFILE)
        assertEquals(Routes.SETTINGS, selected())
        tap(Routes.SETTINGS)
        assertEquals(Routes.SETTINGS, top)
    }

    @Test fun backStillPopsOneScreenAtATime() {
        setUp()
        open(Routes.PROFILE)
        rule.runOnUiThread { nav.popBackStack() }; rule.waitForIdle()
        assertEquals(Routes.HOME, top)
    }

    @Test fun anEditedProfileAsksBeforeTheTabBarLeavesAndKeepsTheDraftOnCancel() {
        var dirty = true
        var asked: (() -> Unit)? = null
        setUp {
            DisposableEffect(Unit) {
                val h: (() -> Unit) -> Boolean = { proceed -> if (dirty) { asked = proceed; true } else false }
                guard.handler = h
                onDispose { if (guard.handler === h) guard.handler = null }
            }
        }
        open(Routes.PROFILE)
        tap(Routes.HOME)
        assertEquals("still on the profile, dialog is up", Routes.PROFILE, top)
        asked = null; // "Keep editing": the proceed callback is dropped, nothing navigates
        assertEquals(Routes.PROFILE, top)
        tap(Routes.HOME)
        asked!!.let { rule.runOnUiThread(it); rule.waitForIdle() }   // "Discard"
        assertEquals(Routes.HOME, top)
        assertNull("the guard is unregistered once the screen is gone", guard.handler)
        dirty = false
    }

    @Test fun selectedTabFollowsTheNearestTabRootBelowTheTop() {
        assertEquals(Routes.HOME, TabNav.selectedTab(listOf(Routes.HOME, Routes.PROFILE), tabs))
        assertEquals(Routes.SETTINGS, TabNav.selectedTab(listOf(Routes.HOME, Routes.SETTINGS, Routes.DEBUG), tabs))
        assertEquals(Routes.MESSAGES, TabNav.selectedTab(listOf(Routes.HOME, Routes.MESSAGES), tabs))
        assertNull(TabNav.selectedTab(emptyList(), tabs))
    }
}
