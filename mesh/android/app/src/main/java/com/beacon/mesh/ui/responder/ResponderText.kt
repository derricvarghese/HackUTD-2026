package com.beacon.mesh.ui.responder

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.beacon.mesh.R
import com.beacon.mesh.responder.ResponderException
import java.util.Locale

/** Maps the contract's category to the app's own category wire names (they differ for water/meds). */
fun appCategory(api: String): String = if (api == "need_water_meds") "water_meds" else api

@Composable
fun statusText(s: String): String = when (s) {
    "reported" -> stringResource(R.string.responder_status_reported)
    "assigned" -> stringResource(R.string.responder_status_assigned)
    "en_route" -> stringResource(R.string.responder_status_en_route)
    "on_scene" -> stringResource(R.string.responder_status_on_scene)
    "resolved" -> stringResource(R.string.responder_status_resolved)
    else -> stringResource(R.string.responder_status_other, s.replace('_', ' ').replaceFirstChar { it.titlecase(Locale.getDefault()) })
}

@Composable
fun flagText(f: String): String = when (f) {
    "mobility" -> stringResource(R.string.flag_mobility)
    "medical" -> stringResource(R.string.flag_medical)
    "elderly" -> stringResource(R.string.flag_elderly)
    "child" -> stringResource(R.string.flag_child)
    "oxygen" -> stringResource(R.string.flag_oxygen)
    "sensory" -> stringResource(R.string.flag_sensory)
    "cognitive" -> stringResource(R.string.flag_cognitive)
    else -> f.replace('_', ' ').replaceFirstChar { it.titlecase(Locale.getDefault()) }
}

@Composable
fun eventText(type: String): String = stringResource(
    when (type) {
        "reported" -> R.string.evt_reported
        "received_via_gateway" -> R.string.evt_received_via_gateway
        "triaged" -> R.string.evt_triaged
        "merged" -> R.string.evt_merged
        "silent_flagged" -> R.string.evt_silent_flagged
        "heartbeat_silent" -> R.string.evt_heartbeat_silent
        "contact_restored" -> R.string.evt_contact_restored
        "checkin_sent" -> R.string.evt_checkin_sent
        "checkin_responded" -> R.string.evt_checkin_responded
        "checkin_missed" -> R.string.evt_checkin_missed
        "self_resolved" -> R.string.evt_self_resolved
        "urgent_help_requested" -> R.string.evt_urgent_help_requested
        "assigned" -> R.string.evt_assigned
        "en_route" -> R.string.evt_en_route
        "on_scene" -> R.string.evt_on_scene
        "resolved" -> R.string.evt_resolved
        "released" -> R.string.evt_released
        "note" -> R.string.evt_note
        "edited" -> R.string.evt_edited
        "closed" -> R.string.evt_closed
        else -> R.string.evt_other
    },
)

@Composable
fun outcomeText(o: String): String = stringResource(
    when (o) {
        "rescued" -> R.string.responder_outcome_rescued
        "safe_on_arrival" -> R.string.responder_outcome_safe_on_arrival
        "referred" -> R.string.responder_outcome_referred
        "unreachable" -> R.string.responder_outcome_unreachable
        else -> R.string.responder_outcome_false_alarm
    },
)

@Composable
fun agoText(ms: Long?, now: Long): String {
    if (ms == null) return stringResource(R.string.responder_unknown)
    // A timestamp from the server can be a little ahead of this phone's clock: never show 'In 0 min.', treat it as just now.
    if (ms > now - 10_000) return stringResource(R.string.responder_just_now)
    return DateUtils.getRelativeTimeSpanString(ms, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()
}

@Composable
fun openCasesText(n: Int): String = pluralStringResource(R.plurals.responder_open_cases, n, n)

@Composable
fun errorText(e: ResponderException): String = when (e.kind) {
    ResponderException.Kind.BAD_CREDENTIALS -> stringResource(R.string.responder_err_credentials)
    ResponderException.Kind.SIGNED_OUT -> stringResource(R.string.responder_err_signed_out)
    ResponderException.Kind.ALREADY_CLAIMED ->
        if (e.detail != null) stringResource(R.string.responder_err_claimed_by, e.detail) else stringResource(R.string.responder_err_claimed)
    ResponderException.Kind.FORBIDDEN -> stringResource(R.string.responder_err_forbidden)
    ResponderException.Kind.NOT_FOUND -> stringResource(R.string.responder_err_not_found)
    ResponderException.Kind.RATE_LIMITED -> stringResource(R.string.responder_err_rate)
    ResponderException.Kind.SERVER -> stringResource(R.string.responder_err_server, e.code ?: 0)
    ResponderException.Kind.OFFLINE -> stringResource(R.string.responder_err_offline)
    ResponderException.Kind.BAD_RESPONSE -> stringResource(R.string.responder_err_bad_response)
}

/** Intents to other apps. Exact coordinates are only ever passed in when the API returned them for this responder. */
object ResponderIntents {
    /** Turn-by-turn to a point: a navigation intent first, then any maps app through a chooser on a geo: URI. */
    fun navigate(context: Context, lat: Double, lng: Double): Boolean =
        tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=$lat,$lng"))) ||
            tryStart(context, Intent.createChooser(Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lng?q=$lat,$lng")), null))

    fun dial(context: Context, number: String): Boolean =
        tryStart(context, Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)))

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
    } catch (e: ActivityNotFoundException) { false } catch (e: SecurityException) { false }
}
