package com.beacon.mesh.units

import java.text.NumberFormat
import java.util.Locale
import kotlin.math.roundToInt

/** The unit system a measurement is shown in. Stored data is always metric (metres, centimetres). */
enum class UnitSystem { METRIC, IMPERIAL }

/** What the user chose in Settings. [AUTOMATIC] follows the phone's region. */
enum class UnitPreference {
    AUTOMATIC, METRIC, IMPERIAL;

    fun resolve(locale: Locale): UnitSystem = when (this) {
        METRIC -> UnitSystem.METRIC
        IMPERIAL -> UnitSystem.IMPERIAL
        AUTOMATIC -> Units.systemFor(locale)
    }
}

enum class LengthUnit(val symbol: String) { METER("m"), KILOMETER("km"), FOOT("ft"), MILE("mi") }

/** A rounded length ready to print: [value] already has the precision it should be shown with ([decimals] digits). */
data class Measure(val value: Double, val unit: LengthUnit, val decimals: Int) {
    /** "5 m", "16 ft", "0.6 mi" with locale digits and decimal separator. */
    fun text(locale: Locale): String = "${number(value, decimals, locale)} ${unit.symbol}"
    fun numberText(locale: Locale): String = number(value, decimals, locale)
}

/** Feet and whole inches. */
data class FeetInches(val feet: Int, val inches: Int) {
    val totalInches: Int get() = feet * 12 + inches
}

/**
 * All unit conversion and formatting lives here (pure, no Android). Callers pass the resolved [UnitSystem].
 * Everything stored or sent stays metric; this only changes what people read and type.
 */
object Units {
    const val CM_PER_INCH = 2.54
    const val METERS_PER_FOOT = 0.3048
    const val METERS_PER_MILE = 1609.344
    const val FEET_PER_MILE = 5280.0

    /** Below 0.1 mile (528 ft) imperial distances stay in feet. */
    const val MILE_SWITCH_FEET = 528.0

    const val HEIGHT_MIN_CM = 30
    const val HEIGHT_MAX_CM = 260
    const val FEET_MIN = 1
    const val FEET_MAX = 8
    const val INCHES_MAX = 11

    private val IMPERIAL_REGIONS = setOf("US", "LR", "MM")

    /** Imperial for the United States, Liberia and Myanmar; metric everywhere else (also for an unknown region). */
    fun systemFor(locale: Locale): UnitSystem =
        if (locale.country.uppercase(Locale.ROOT) in IMPERIAL_REGIONS) UnitSystem.IMPERIAL else UnitSystem.METRIC

    // ------------------------------------------------------------------ height

    /** cm -> feet + inches, rounded to the nearest inch (30 cm is 1 ft 0 in, 260 cm is 8 ft 6 in). */
    fun cmToFeetInches(cm: Int): FeetInches {
        val total = (cm / CM_PER_INCH).roundToInt().coerceAtLeast(0)
        return FeetInches(total / 12, total % 12)
    }

    /** Exact stored value for a pair of feet/inches: round((ft*12+in)*2.54). */
    fun feetInchesToCm(feet: Int, inches: Int): Int = ((feet * 12 + inches) * CM_PER_INCH).roundToInt()

    /** Typed feet/inches to centimetres. Null unless feet are 1..8, inches 0..11 and the result is 30..260 cm. */
    fun parseHeightFeetInches(feet: String, inches: String): Int? {
        val f = feet.trim().toIntOrNull() ?: return null
        val i = inches.trim().ifEmpty { "0" }.toIntOrNull() ?: return null
        if (f !in FEET_MIN..FEET_MAX || i !in 0..INCHES_MAX) return null
        return feetInchesToCm(f, i).takeIf { it in HEIGHT_MIN_CM..HEIGHT_MAX_CM }
    }

    /** Typed centimetres. Null unless a whole number 30..260. */
    fun parseHeightCm(text: String): Int? = text.trim().toIntOrNull()?.takeIf { it in HEIGHT_MIN_CM..HEIGHT_MAX_CM }

    /** "178 cm" or "5 ft 10 in". */
    fun formatHeight(cm: Int, system: UnitSystem, locale: Locale = Locale.getDefault()): String = when (system) {
        UnitSystem.METRIC -> "${number(cm.toDouble(), 0, locale)} cm"
        UnitSystem.IMPERIAL -> cmToFeetInches(cm).let { "${number(it.feet.toDouble(), 0, locale)} ft ${number(it.inches.toDouble(), 0, locale)} in" }
    }

    // ------------------------------------------------------------------ distances

    /**
     * A distance rounded for reading: metric whole metres under 1 km, then kilometres with one decimal;
     * imperial whole feet under 0.1 mile (528 ft), then miles with one decimal.
     */
    fun distance(meters: Double, system: UnitSystem): Measure {
        val m = meters.coerceAtLeast(0.0)
        return when (system) {
            UnitSystem.METRIC ->
                if (m < 999.5) Measure(Math.round(m).toDouble(), LengthUnit.METER, 0)
                else tenths(Math.round(m / 100.0) / 10.0, LengthUnit.KILOMETER)
            UnitSystem.IMPERIAL -> {
                val ft = m / METERS_PER_FOOT
                if (ft < MILE_SWITCH_FEET) Measure(Math.round(ft).toDouble(), LengthUnit.FOOT, 0)
                else tenths(Math.round(m / METERS_PER_MILE * 10.0) / 10.0, LengthUnit.MILE)
            }
        }
    }

    /** One decimal, but a whole value prints without ".0" ("1 km", not "1.0 km"). */
    private fun tenths(v: Double, unit: LengthUnit) = Measure(v, unit, if (v == Math.rint(v)) 0 else 1)

    fun formatDistance(meters: Double, system: UnitSystem, locale: Locale = Locale.getDefault()): String =
        distance(meters, system).text(locale)

    /**
     * A GPS accuracy radius without false precision. Metric: whole metres under 10, 5 m steps under 100, 10 m beyond.
     * Imperial: whole feet under 30, 5 ft steps under 300, 10 ft beyond (then miles like [distance]).
     */
    fun accuracy(meters: Double, system: UnitSystem): Measure {
        val m = meters.coerceAtLeast(1.0)
        return when (system) {
            UnitSystem.METRIC -> {
                val r = when {
                    m < 10 -> Math.round(m).toDouble()
                    m < 100 -> Math.round(m / 5) * 5.0
                    else -> Math.round(m / 10) * 10.0
                }
                distance(r, UnitSystem.METRIC)
            }
            UnitSystem.IMPERIAL -> {
                val ft = m / METERS_PER_FOOT
                if (ft >= MILE_SWITCH_FEET) return distance(m, UnitSystem.IMPERIAL)
                val r = when {
                    ft < 30 -> Math.round(ft).toDouble()
                    ft < 300 -> Math.round(ft / 5) * 5.0
                    else -> Math.round(ft / 10) * 10.0
                }
                Measure(r, LengthUnit.FOOT, 0)
            }
        }
    }

    fun formatAccuracy(meters: Double, system: UnitSystem, locale: Locale = Locale.getDefault()): String =
        accuracy(meters, system).text(locale)
}

internal fun number(value: Double, decimals: Int, locale: Locale): String =
    NumberFormat.getNumberInstance(locale).apply {
        minimumFractionDigits = decimals
        maximumFractionDigits = decimals
        isGroupingUsed = false
    }.format(value)
