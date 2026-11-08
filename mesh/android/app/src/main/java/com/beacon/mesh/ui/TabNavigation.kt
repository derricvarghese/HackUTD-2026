package com.beacon.mesh.ui

import androidx.compose.runtime.compositionLocalOf
import androidx.navigation.NavController

internal object Routes {
    const val HOME = "home"
    const val MESSAGES = "messages"
    const val MESH = "mesh"
    const val RESPONDER = "responder"
    const val SETTINGS = "settings"
    const val DEBUG = "settings/debug"
    const val PROFILE = "settings/profile"
}

/**
 * Bottom-bar / rail navigation. Tapping a tab always shows that tab's root:
 * - already there: nothing to do;
 * - the tab's root is somewhere below the top of the stack (a detail screen is open on it): pop back to it;
 * - otherwise go to it, dropping every other tab's stack (no saveState/restoreState: restoring the saved stack of a
 *   tab is what brought the profile screen back when Home was tapped, because the pop that preceded the navigate saved it).
 */
internal object TabNav {
    /** The tab the user is "in": the nearest tab root at or below the top of the back stack (Profile opened from Home belongs to Home). */
    fun selectedTab(stackRoutes: List<String?>, tabs: Collection<String>): String? =
        stackRoutes.asReversed().firstOrNull { it != null && it in tabs }

    fun goTop(nav: NavController, route: String, start: String = Routes.HOME) {
        if (nav.currentDestination?.route == route) return
        if (nav.popBackStack(route, inclusive = false)) return
        nav.navigate(route) {
            popUpTo(start) { inclusive = false; saveState = false }
            launchSingleTop = true
            restoreState = false
        }
    }
}

/**
 * Lets a screen with unsaved edits ask before the navigation bar takes the user away.
 * The screen registers [handler]; it returns true when it took over (and will call `proceed` itself once the user agrees).
 */
class LeaveGuard {
    var handler: ((proceed: () -> Unit) -> Boolean)? = null

    /** Runs [proceed] now, or after the user confirmed leaving. */
    fun request(proceed: () -> Unit) {
        if (handler?.invoke(proceed) != true) proceed()
    }
}

val LocalLeaveGuard = compositionLocalOf { LeaveGuard() }
