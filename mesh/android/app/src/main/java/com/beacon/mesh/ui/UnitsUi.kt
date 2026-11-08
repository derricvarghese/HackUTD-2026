package com.beacon.mesh.ui

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import com.beacon.mesh.R
import com.beacon.mesh.units.FeetInches
import com.beacon.mesh.units.LengthUnit
import com.beacon.mesh.units.Measure
import com.beacon.mesh.units.UnitPreference
import com.beacon.mesh.units.UnitSystem
import com.beacon.mesh.units.Units
import com.beacon.mesh.units.number
import java.util.Locale

/** The resolved unit system for the whole app (Settings > Units, Automatic follows the phone's region). */
val LocalUnitSystem = compositionLocalOf { UnitSystem.METRIC }

@Composable
fun rememberUnitSystem(pref: UnitPreference): UnitSystem {
    val locale = currentLocale()
    return remember(pref, locale) { pref.resolve(locale) }
}

@Composable
fun currentLocale(): Locale {
    val conf = LocalConfiguration.current
    return conf.locales.get(0) ?: Locale.getDefault()
}

/** "5 feet 10 inches" / "178 centimetres" for TalkBack. */
fun heightSpoken(res: Resources, cm: Int, system: UnitSystem, locale: Locale): String = when (system) {
    UnitSystem.METRIC -> res.getQuantityString(R.plurals.spoken_centimeters, cm, number(cm.toDouble(), 0, locale))
    UnitSystem.IMPERIAL -> feetInchesSpoken(res, Units.cmToFeetInches(cm), locale)
}

fun feetInchesSpoken(res: Resources, fi: FeetInches, locale: Locale): String =
    res.getQuantityString(R.plurals.spoken_feet, fi.feet, number(fi.feet.toDouble(), 0, locale)) + " " +
        res.getQuantityString(R.plurals.spoken_inches, fi.inches, number(fi.inches.toDouble(), 0, locale))

/** "16 feet", "0.6 miles" for TalkBack. */
fun measureSpoken(res: Resources, m: Measure, locale: Locale): String {
    val count = if (m.decimals == 0) m.value.toInt() else 2
    val plural = when (m.unit) {
        LengthUnit.METER -> R.plurals.spoken_meters
        LengthUnit.KILOMETER -> R.plurals.spoken_kilometers
        LengthUnit.FOOT -> R.plurals.spoken_feet
        LengthUnit.MILE -> R.plurals.spoken_miles
    }
    return res.getQuantityString(plural, count, m.numberText(locale))
}

/** "GPS, about 16 ft" style text and its spoken form. */
@Composable
fun accuracyText(meters: Double): Pair<String, String> {
    val system = LocalUnitSystem.current
    val locale = currentLocale()
    val res = LocalContext.current.resources
    val m = Units.accuracy(meters, system)
    return res.getString(R.string.approx_value, m.text(locale)) to res.getString(R.string.approx_value, measureSpoken(res, m, locale))
}
