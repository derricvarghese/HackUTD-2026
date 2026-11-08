package com.beacon.mesh.ui.logic

import java.net.URI

/** Validation of the gateway backend URL typed by the user. Pure, JVM-testable. */
sealed interface BackendUrlResult {
    /** Blank input: gateway uploads are disabled. */
    data object Empty : BackendUrlResult
    data class Valid(val normalized: String) : BackendUrlResult
    data class Invalid(val reason: Reason) : BackendUrlResult

    enum class Reason { MISSING_SCHEME, MISSING_HOST, BAD_FORMAT, HAS_QUERY }
}

object BackendUrl {
    fun validate(input: String): BackendUrlResult {
        val text = input.trim()
        if (text.isEmpty()) return BackendUrlResult.Empty
        val lower = text.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return BackendUrlResult.Invalid(BackendUrlResult.Reason.MISSING_SCHEME)
        }
        if (text.any { it.isWhitespace() }) return BackendUrlResult.Invalid(BackendUrlResult.Reason.BAD_FORMAT)
        if (text.substringAfter("://").isBlank()) return BackendUrlResult.Invalid(BackendUrlResult.Reason.MISSING_HOST)
        val uri = try { URI(text) } catch (e: Exception) { return BackendUrlResult.Invalid(BackendUrlResult.Reason.BAD_FORMAT) }
        if (uri.host.isNullOrBlank()) return BackendUrlResult.Invalid(BackendUrlResult.Reason.MISSING_HOST)
        if (uri.port !in -1..65535) return BackendUrlResult.Invalid(BackendUrlResult.Reason.BAD_FORMAT)
        if (uri.rawQuery != null || uri.rawFragment != null) return BackendUrlResult.Invalid(BackendUrlResult.Reason.HAS_QUERY)
        return BackendUrlResult.Valid(text.trimEnd('/'))
    }
}
