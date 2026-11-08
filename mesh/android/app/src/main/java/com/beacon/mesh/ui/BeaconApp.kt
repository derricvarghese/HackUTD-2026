package com.beacon.mesh.ui

import android.graphics.Color as AndroidColor
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.HealthAndSafety
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.window.core.layout.WindowSizeClass
import com.beacon.mesh.R
import com.beacon.mesh.SendError
import com.beacon.mesh.ui.components.NoInsets
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.haptics.rememberHaptics
import com.beacon.mesh.ui.logic.MessageItem
import com.beacon.mesh.ui.logic.MessageUi
import com.beacon.mesh.ui.responder.ResponderScreen
import com.beacon.mesh.ui.responder.ResponderViewModel
import com.beacon.mesh.ui.screens.DebugScreen
import com.beacon.mesh.ui.screens.HomeScreen
import com.beacon.mesh.ui.screens.MeshStatusScreen
import com.beacon.mesh.ui.screens.MessagesScreen
import com.beacon.mesh.ui.screens.OnboardingScreen
import com.beacon.mesh.ui.screens.SettingsScreen
import com.beacon.mesh.ui.screens.SosSheet
import com.beacon.mesh.ui.screens.ProfileOnboardingScreen
import com.beacon.mesh.ui.screens.ProfileReconsentDialog
import com.beacon.mesh.ui.screens.ProfileSettingsScreen
import com.beacon.mesh.ui.theme.BeaconTheme
import com.beacon.mesh.ui.theme.isDark
import com.beacon.mesh.ui.welfare.WelfareAnswerScreen
import com.beacon.mesh.welfare.WelfareLaunch
import com.beacon.mesh.welfare.WelfareResponse

private enum class Stage { PERMISSIONS, PROFILE, MAIN }

private data class TopLevel(val route: String, val label: Int, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val ResponderTop = TopLevel(Routes.RESPONDER, R.string.nav_responder, Icons.Rounded.HealthAndSafety)

/** The Responder tab only exists while responder mode is on, so the victim app is unchanged otherwise. */
private fun topLevels(responderMode: Boolean) = listOfNotNull(
    TopLevel(Routes.HOME, R.string.nav_home, Icons.Rounded.Home),
    TopLevel(Routes.MESSAGES, R.string.nav_messages, Icons.Rounded.Inbox),
    TopLevel(Routes.MESH, R.string.nav_mesh, Icons.Rounded.Hub),
    ResponderTop.takeIf { responderMode },
    TopLevel(Routes.SETTINGS, R.string.nav_settings, Icons.Rounded.Settings),
)

@Composable
fun BeaconApp(
    vm: MeshViewModel = viewModel(),
    profileVm: ProfileViewModel = viewModel(),
    responderVm: ResponderViewModel = viewModel(),
) {
    val settings by vm.settings.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val reduceMotion = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val appHaptics = rememberHaptics(settings.hapticsEnabled)
    val unitSystem = rememberUnitSystem(settings.unitPreference)
    CompositionLocalProvider(LocalHaptics provides appHaptics, LocalUnitSystem provides unitSystem) {
    BeaconTheme(settings.themeMode, settings.dynamicColor, reduceMotion) {
        val dark = isDark(settings.themeMode)
        val activity = LocalActivity.current as? ComponentActivity
        DisposableEffect(dark, activity) {
            // Re-apply when the user's theme choice differs from the system's, so bar icons stay legible.
            activity?.enableEdgeToEdge(
                statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) { dark },
                navigationBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) { dark },
            )
            onDispose {}
        }
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            val holder = rememberSystemStatus()
            val ready = holder.status.readiness.canRunMesh
            // Start the relay only after onboarding, never from a cold crisis tap.
            LaunchedEffect(settings.onboardingDone, ready) {
                if (settings.onboardingDone && ready) vm.startMesh()
            }
            val effects = MaterialTheme.motionScheme.defaultEffectsSpec<Float>()
            val fast = MaterialTheme.motionScheme.fastEffectsSpec<Float>()
            val spatial = MaterialTheme.motionScheme.defaultSpatialSpec<Float>()
            val profileStatus by vm.mesh.collectAsStateWithLifecycle()
            val stage = when {
                !settings.onboardingDone -> Stage.PERMISSIONS
                !profileStatus.profile.stepDone -> Stage.PROFILE
                else -> Stage.MAIN
            }
            AnimatedContent(
                targetState = stage,
                transitionSpec = { (fadeIn(effects) + scaleIn(spatial, 0.96f)) togetherWith fadeOut(fast) },
                label = "onboarding",
            ) { st ->
                when (st) {
                    Stage.PERMISSIONS -> OnboardingScreen(
                        holder = holder,
                        askedPermissions = settings.askedPermissions,
                        onAsked = vm::markPermissionsAsked,
                        onFinish = { vm.setOnboardingDone(true) },
                    )
                    Stage.PROFILE -> ProfileOnboardingScreen(profileVm)
                    Stage.MAIN -> MainShell(vm, holder, profileVm, responderVm, dark)
                }
            }
        }
    }
    }
}

@Composable
private fun MainShell(vm: MeshViewModel, holder: SystemStatusHolder, profileVm: ProfileViewModel, responderVm: ResponderViewModel, dark: Boolean) {
    val mesh by vm.mesh.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val system = holder.status

    val items: List<MessageItem> = remember(mesh.messages, mesh.sentToPeers, mesh.uploadingIds, mesh.checkins) {
        mesh.messages.map { MessageUi.map(it, mesh.sentToPeers, mesh.uploadingIds, mesh.checkins) }
    }

    val nav = rememberNavController()
    val backEntry by nav.currentBackStackEntryAsState()
    val topLevels = remember(settings.responderMode) { topLevels(settings.responderMode) }
    // The tab that owns the current screen: Profile opened from Home keeps Home selected, Debug keeps Settings.
    val selectedTab = TabNav.selectedTab(
        // Secondary screens are only ever one level above their tab root, so the entry below the top is enough.
        listOf(nav.previousBackStackEntry?.destination?.route, backEntry?.destination?.route),
        topLevels.map { it.route },
    )
    fun selected(route: String) = route == selectedTab

    val leaveGuard = remember { LeaveGuard() }
    fun goTop(route: String) = leaveGuard.request { TabNav.goTop(nav, route) }

    LaunchedEffect(settings.responderMode, backEntry?.destination?.route) {
        if (!settings.responderMode && backEntry?.destination?.route == Routes.RESPONDER) goTop(Routes.HOME)
    }

    var requestedMessage by rememberSaveable { mutableStateOf<String?>(null) }
    fun openMessage(id: String) { requestedMessage = id; goTop(Routes.MESSAGES) }

    // ---- feedback for sent alerts ----
    val snackbar = remember { SnackbarHostState() }
    val haptics = LocalHaptics.current
    val sentText = stringResource(R.string.snack_sent)
    val failedText = stringResource(R.string.snack_failed)
    val noKeyText = stringResource(R.string.snack_failed_no_key)
    val noLocationText = stringResource(R.string.snack_failed_no_location)
    val viewText = stringResource(R.string.action_view)
    val welfareStill = stringResource(R.string.welfare_snack_still)
    val welfareResolved = stringResource(R.string.welfare_resolved_message)
    val welfareUrgent = stringResource(R.string.welfare_snack_urgent)
    val welfareClosed = stringResource(R.string.welfare_snack_closed)
    val identityDoneFmt = stringResource(R.string.debug_identity_done)
    LaunchedEffect(Unit) {
        vm.events.collect { e ->
            when (e) {
                is UiEvent.SosSent -> {
                    // The hold-to-send button already played the "pop"; no second buzz here.
                    val r = snackbar.showSnackbar(sentText, viewText, duration = SnackbarDuration.Long)
                    if (r == SnackbarResult.ActionPerformed) {
                        haptics.perform(HapticEvent.LightTap)
                        openMessage(e.messageId)
                    }
                }
                is UiEvent.WelfareAnswered -> {
                    WelfareLaunch.close()
                    snackbar.showSnackbar(
                        when (e.response) {
                            WelfareResponse.NO_LONGER_NEED_HELP -> welfareResolved
                            WelfareResponse.NEED_URGENT_HELP -> welfareUrgent
                            else -> welfareStill
                        }
                    )
                }
                is UiEvent.IdentityReset -> {
                    haptics.perform(HapticEvent.Success)
                    snackbar.showSnackbar(identityDoneFmt.format(e.newId, e.oldId))
                }
                is UiEvent.SosFailed -> {
                    haptics.perform(HapticEvent.Error)
                    snackbar.showSnackbar(
                        when (e.error) {
                            SendError.NO_BACKEND_KEY -> noKeyText
                            SendError.NO_LOCATION -> noLocationText
                            else -> failedText
                        }
                    )
                }
            }
        }
    }

    val wide = currentWindowAdaptiveInfo().windowSizeClass
        .isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    // At large font scales labels would clip: show icons only (content description keeps TalkBack labels).
    val showLabels = androidx.compose.ui.platform.LocalDensity.current.fontScale <= 1.3f
    val imeVisible = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0

    val navHost: @Composable (Modifier) -> Unit = { modifier ->
        CompositionLocalProvider(LocalLeaveGuard provides leaveGuard) {
            ShellNavHost(nav, modifier, vm, profileVm, responderVm, dark, mesh, items, system, settings, requestedMessage,
                onRequestConsumed = { requestedMessage = null },
                onOpenMessage = ::openMessage,
                onGoTop = ::goTop,
            )
        }
    }

    Row(Modifier.fillMaxSize()) {
        if (wide) {
            NavigationRail(
                windowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Start + WindowInsetsSides.Vertical),
            ) {
                topLevels.forEach { t ->
                    NavigationRailItem(
                        selected = selected(t.route),
                        onClick = haptics.onClick(HapticEvent.Navigate) { goTop(t.route) },
                        icon = { Icon(t.icon, contentDescription = if (showLabels) null else stringResource(t.label)) },
                        label = { Text(stringResource(t.label)) },
                        alwaysShowLabel = showLabels,
                    )
                }
            }
        }
        Scaffold(
            modifier = Modifier.weight(1f),
            containerColor = androidx.compose.ui.graphics.Color.Transparent,
            contentWindowInsets = WindowInsets.safeDrawing.only(
                if (wide) WindowInsetsSides.End + WindowInsetsSides.Bottom else WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom,
            ),
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                // Hidden while the keyboard is open so text fields are never squeezed.
                if (!wide && !imeVisible) {
                    NavigationBar {
                        topLevels.forEach { t ->
                            NavigationBarItem(
                                selected = selected(t.route),
                                onClick = haptics.onClick(HapticEvent.Navigate) { goTop(t.route) },
                                icon = { Icon(t.icon, contentDescription = if (showLabels) null else stringResource(t.label)) },
                                label = { Text(stringResource(t.label), maxLines = 1) },
                                alwaysShowLabel = showLabels,
                            )
                        }
                    }
                }
            },
        ) { inner ->
            navHost(Modifier.padding(inner).consumeWindowInsets(inner))
        }
    }

    var reconsentLater by rememberSaveable { mutableStateOf(false) }
    if (mesh.profile.syncState == com.beacon.mesh.profile.SyncState.NEEDS_CONSENT && mesh.profile.hasProfile && !reconsentLater) {
        ProfileReconsentDialog(onAgree = profileVm::reconsent, onLater = { reconsentLater = true })
    }

    // Welfare check-in confirmation (from the notification, or the Home card): three big answers, back closes without answering.
    val requestedCheckin by WelfareLaunch.requested.collectAsStateWithLifecycle()
    requestedCheckin?.let { cid ->
        val prompt = mesh.checkins.firstOrNull { it.checkinId == cid }
        if (prompt != null && prompt.isPending(System.currentTimeMillis())) {
            WelfareAnswerScreen(prompt, onAnswer = { vm.answerCheckin(cid, it) }, onClose = WelfareLaunch::close)
        } else {
            LaunchedEffect(cid) {
                WelfareLaunch.close()
                snackbar.showSnackbar(welfareClosed)
            }
        }
    }

    draft?.let { d ->
        SosSheet(
            draft = d,
            gps = mesh.gps,
            locationAllowed = system.locationPermission && system.locationOn,
            onNote = vm::setNote,
            onPeople = vm::setPeople,
            onAddImage = vm::addImage,
            onRemoveImage = vm::removeImage,
            onImageCaption = vm::updateImageCaption,
            onConfirm = vm::confirmSos,
            onDismiss = vm::cancelSos,
        )
    }
}

@Composable
private fun ShellNavHost(
    nav: androidx.navigation.NavHostController,
    modifier: Modifier,
    vm: MeshViewModel,
    profileVm: ProfileViewModel,
    responderVm: ResponderViewModel,
    dark: Boolean,
    mesh: com.beacon.mesh.MeshSnapshot,
    items: List<MessageItem>,
    system: SystemStatus,
    settings: UiSettings,
    requestedMessage: String?,
    onRequestConsumed: () -> Unit,
    onOpenMessage: (String) -> Unit,
    onGoTop: (String) -> Unit,
) {
    val spatial = MaterialTheme.motionScheme.defaultSpatialSpec<IntOffset>()
    val floatSpatial = MaterialTheme.motionScheme.defaultSpatialSpec<Float>()
    val effects = MaterialTheme.motionScheme.defaultEffectsSpec<Float>()
    val fastEffects = MaterialTheme.motionScheme.fastEffectsSpec<Float>()

    // Top level tabs: fade-through with a small scale. Predictive back reuses pop* transitions.
    val enter: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition =
        { fadeIn(effects) + scaleIn(floatSpatial, 0.94f) }
    val exit: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = { fadeOut(fastEffects) }
    val popEnter: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition =
        { fadeIn(effects) + scaleIn(floatSpatial, 1.06f) }
    val popExit: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition =
        { fadeOut(fastEffects) + scaleOut(floatSpatial, 0.92f) }

    NavHost(
        navController = nav,
        startDestination = Routes.HOME,
        modifier = modifier,
        enterTransition = enter,
        exitTransition = exit,
        popEnterTransition = popEnter,
        popExitTransition = popExit,
    ) {
        composable(Routes.HOME) {
            HomeScreen(
                mesh = mesh,
                items = items,
                system = system,
                onSos = vm::openSos,
                onOpenMessage = onOpenMessage,
                onFixSetup = { vm.setOnboardingDone(false) },
                onOpenMesh = { onGoTop(Routes.MESH) },
                onOpenCheckin = WelfareLaunch::open,
                onOpenProfile = { nav.navigate(Routes.PROFILE) { launchSingleTop = true } },
                onRetryProfile = profileVm::retrySync,
                onDismissProfileBanner = profileVm::dismissBanner,
            )
        }
        composable(Routes.MESSAGES) {
            MessagesScreen(items, mesh.relayId, requestedMessage, onRequestConsumed)
        }
        composable(Routes.MESH) { MeshStatusScreen(mesh, items, system) }
        composable(Routes.RESPONDER) { ResponderScreen(responderVm, mesh.messages, dark) }
        composable(
            Routes.SETTINGS,
            exitTransition = { slideOutHorizontally(spatial) { -it / 4 } + fadeOut(fastEffects) },
            popEnterTransition = { slideInHorizontally(spatial) { -it / 4 } + fadeIn(effects) },
        ) {
            SettingsScreen(
                settings = settings,
                mesh = mesh,
                system = system,
                onTheme = vm::setThemeMode,
                onDynamic = vm::setDynamicColor,
                onUnits = vm::setUnitPreference,
                onHaptics = vm::setHapticsEnabled,
                onResponderMode = { on ->
                    vm.setResponderMode(on)
                    // Turning the mode off signs out and wipes the stored session.
                    if (!on) responderVm.signOut()
                },
                onOpenDebug = { nav.navigate(Routes.DEBUG) },
                onOpenProfile = { nav.navigate(Routes.PROFILE) { launchSingleTop = true } },
                onRetryProfile = profileVm::retrySync,
            )
        }
        composable(
            Routes.PROFILE,
            enterTransition = { slideInHorizontally(spatial) { it } + fadeIn(effects) },
            exitTransition = { slideOutHorizontally(spatial) { -it / 4 } + fadeOut(fastEffects) },
            popEnterTransition = { slideInHorizontally(spatial) { -it / 4 } + fadeIn(effects) },
            popExitTransition = { slideOutHorizontally(spatial) { it } + fadeOut(fastEffects) },
        ) {
            ProfileSettingsScreen(profileVm, onBack = { nav.popBackStack() })
        }
        composable(
            Routes.DEBUG,
            enterTransition = { slideInHorizontally(spatial) { it } + fadeIn(effects) },
            exitTransition = { slideOutHorizontally(spatial) { -it / 4 } + fadeOut(fastEffects) },
            popEnterTransition = { slideInHorizontally(spatial) { -it / 4 } + fadeIn(effects) },
            popExitTransition = { slideOutHorizontally(spatial) { it } + fadeOut(fastEffects) },
        ) {
            DebugScreen(
                mesh = mesh,
                onBack = { nav.popBackStack() },
                onHopCap = vm::setHopCap,
                onForceOffline = vm::setForceOffline,
                onTestWelfare = vm::scheduleTestCheckin,
                onResetIdentity = vm::resetIdentity,
            )
        }
    }
}
