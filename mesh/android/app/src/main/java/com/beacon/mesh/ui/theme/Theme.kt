package com.beacon.mesh.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

enum class ThemeMode { SYSTEM, LIGHT, DARK }

/**
 * Hand-made fallback for Android < 12 or when dynamic color is off: an emergency red primary,
 * orange secondary, calm teal tertiary, warm neutrals.
 */
private val LightScheme = lightColorScheme(
    primary = Color(0xFFB3261E), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFDAD5), onPrimaryContainer = Color(0xFF410002),
    secondary = Color(0xFF9C4400), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFFFDBC8), onSecondaryContainer = Color(0xFF331200),
    tertiary = Color(0xFF006A60), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFF9EF2E3), onTertiaryContainer = Color(0xFF00201C),
    error = Color(0xFF8C0009), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
    background = Color(0xFFFFF8F6), onBackground = Color(0xFF231918),
    surface = Color(0xFFFFF8F6), onSurface = Color(0xFF231918),
    surfaceVariant = Color(0xFFF5DDDA), onSurfaceVariant = Color(0xFF534341),
    outline = Color(0xFF857370), outlineVariant = Color(0xFFD8C2BE),
    inverseSurface = Color(0xFF392E2C), inverseOnSurface = Color(0xFFFFEDEA), inversePrimary = Color(0xFFFFB4A9),
    surfaceDim = Color(0xFFE8D6D3), surfaceBright = Color(0xFFFFF8F6),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFFFF0EE),
    surfaceContainer = Color(0xFFFCEAE7), surfaceContainerHigh = Color(0xFFF7E4E1),
    surfaceContainerHighest = Color(0xFFF1DEDC),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFFFFB4A9), onPrimary = Color(0xFF690005),
    primaryContainer = Color(0xFF93000A), onPrimaryContainer = Color(0xFFFFDAD4),
    secondary = Color(0xFFFFB68E), onSecondary = Color(0xFF532200),
    secondaryContainer = Color(0xFF773300), onSecondaryContainer = Color(0xFFFFDBC8),
    tertiary = Color(0xFF82D5C7), onTertiary = Color(0xFF003731),
    tertiaryContainer = Color(0xFF005048), onTertiaryContainer = Color(0xFF9EF2E3),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF1A1110), onBackground = Color(0xFFF1DFDC),
    surface = Color(0xFF1A1110), onSurface = Color(0xFFF1DFDC),
    surfaceVariant = Color(0xFF534341), onSurfaceVariant = Color(0xFFD8C2BE),
    outline = Color(0xFFA08C89), outlineVariant = Color(0xFF534341),
    inverseSurface = Color(0xFFF1DFDC), inverseOnSurface = Color(0xFF392E2C), inversePrimary = Color(0xFFB3261E),
    surfaceDim = Color(0xFF1A1110), surfaceBright = Color(0xFF423735),
    surfaceContainerLowest = Color(0xFF140C0B), surfaceContainerLow = Color(0xFF231918),
    surfaceContainer = Color(0xFF271D1C), surfaceContainerHigh = Color(0xFF322826),
    surfaceContainerHighest = Color(0xFF3D3231),
)

/**
 * Semantic colors for SOS categories. They stay red / orange / green even with Material You,
 * because the meaning of these colors must not change with the wallpaper.
 */
@Immutable
data class CategoryColors(
    val danger: Color, val onDanger: Color, val dangerContainer: Color, val onDangerContainer: Color,
    val warn: Color, val onWarn: Color, val warnContainer: Color, val onWarnContainer: Color,
    val safe: Color, val onSafe: Color, val safeContainer: Color, val onSafeContainer: Color,
)

private val LightCategoryColors = CategoryColors(
    danger = Color(0xFFB3261E), onDanger = Color.White, dangerContainer = Color(0xFFFFDAD5), onDangerContainer = Color(0xFF410002),
    warn = Color(0xFFB45309), onWarn = Color.White, warnContainer = Color(0xFFFFDDB8), onWarnContainer = Color(0xFF2D1600),
    safe = Color(0xFF1B6D2F), onSafe = Color.White, safeContainer = Color(0xFFA9F5B4), onSafeContainer = Color(0xFF002109),
)
private val DarkCategoryColors = CategoryColors(
    danger = Color(0xFFFFB4A9), onDanger = Color(0xFF690005), dangerContainer = Color(0xFF93000A), onDangerContainer = Color(0xFFFFDAD6),
    warn = Color(0xFFFFB86B), onWarn = Color(0xFF4A2800), warnContainer = Color(0xFF6A3B00), onWarnContainer = Color(0xFFFFDDB8),
    safe = Color(0xFF8DD99B), onSafe = Color(0xFF00391A), safeContainer = Color(0xFF00522A), onSafeContainer = Color(0xFFA9F5B4),
)

val LocalCategoryColors = staticCompositionLocalOf { LightCategoryColors }

/** True when the user turned animations off in system settings (animator scale 0). */
val LocalReduceMotion = staticCompositionLocalOf { false }

@Composable
fun BeaconTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    dynamicColor: Boolean = true,
    reduceMotion: Boolean = false,
    content: @Composable () -> Unit,
) {
    val dark = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val context = LocalContext.current
    val scheme: ColorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> DarkScheme
        else -> LightScheme
    }
    MaterialExpressiveTheme(
        colorScheme = scheme,
        motionScheme = MotionScheme.expressive(),
    ) {
        CompositionLocalProvider(
            LocalCategoryColors provides if (dark) DarkCategoryColors else LightCategoryColors,
            LocalReduceMotion provides reduceMotion,
            content = content,
        )
    }
}

/** Resolves dark/light from the user's preference; shared with the activity for system bar icons. */
@Composable
fun isDark(themeMode: ThemeMode): Boolean = when (themeMode) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
}
