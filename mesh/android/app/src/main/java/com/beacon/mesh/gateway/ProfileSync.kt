package com.beacon.mesh.gateway

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.profile.ProfileRecord
import com.beacon.mesh.profile.ProfileRepository
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.profile.SyncState

/** What one [ProfileSync.run] did, for tests and the status screen. Never carries profile content. */
sealed interface ProfileSyncOutcome {
    data object Idle : ProfileSyncOutcome
    data class Synced(val version: Int) : ProfileSyncOutcome
    /** Not tried (backoff) or nothing to do. */
    data object Deferred : ProfileSyncOutcome
    data object NeedsConsent : ProfileSyncOutcome
    data object Offline : ProfileSyncOutcome
    data class Failed(val reason: String) : ProfileSyncOutcome
    data object Erased : ProfileSyncOutcome
}

/**
 * Keeps the server copy of the profile in step with the encrypted local copy (openapi.yaml, Profiles):
 *  - PENDING/FAILED: `PUT /devices/{id}/profile` with `If-Match: <last acked version>` (0 = create only); stores the returned version.
 *  - 409: `GET` the profile, adopt its version, retry once (the phone is the only writer, so local content wins).
 *  - 422 on consent: refresh /server-info; if the version really changed ask the user again (NEEDS_CONSENT), else FAILED.
 *  - 404 on GET / `Device.profile_version` null or lower than local: the server lost it (retention purge, reinstall) -> PUT again.
 *  - 429 / network / 5xx: exponential backoff (Retry-After honoured), state keeps the retry hint for the UI.
 *  - A pending erase (user deleted the profile) is sent as `DELETE` until the server confirms.
 * Blocking; run on the IO thread. Profile content is never logged: [log] only receives fixed phrases.
 */
class ProfileSync(
    private val api: BeaconApi,
    private val repo: ProfileRepository,
    private val config: BackendConfig,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    private var lastVerifyAt = 0L

    fun run(force: Boolean = false): ProfileSyncOutcome {
        val rec = repo.current
        if (rec.pendingErase) return erase(rec, force)
        val profile = rec.profile ?: return ProfileSyncOutcome.Idle
        val consent = rec.consent
        if (consent == null || config.profileConsentVersion.let { it != null && it != consent.version }) {
            if (rec.syncState != SyncState.NEEDS_CONSENT) repo.update { it.copy(syncState = SyncState.NEEDS_CONSENT, lastError = ERR_CONSENT) }
            return ProfileSyncOutcome.NeedsConsent
        }
        if (rec.syncState == SyncState.NEEDS_CONSENT) return ProfileSyncOutcome.NeedsConsent
        if (!force && rec.nextAttemptAtMs > now()) return ProfileSyncOutcome.Deferred
        if (!force && rec.syncState == SyncState.FAILED && rec.lastError == ERR_REJECTED) return ProfileSyncOutcome.Deferred
        if (ProfileRules.validate(profile, now()).isNotEmpty()) {
            repo.update { it.copy(syncState = SyncState.FAILED, lastError = ERR_REJECTED) }
            return ProfileSyncOutcome.Failed(ERR_REJECTED)
        }
        if (rec.syncState == SyncState.SYNCED) return verify(rec, force)
        return put(rec, rec.profileVersion, retried = false)
    }

    /** Synced locally: confirm cheaply (no profile body) that the server still holds at least our version. */
    private fun verify(rec: ProfileRecord, force: Boolean): ProfileSyncOutcome {
        if (!force && now() - lastVerifyAt < VERIFY_EVERY_MS) return ProfileSyncOutcome.Idle
        return when (val r = api.deviceProfileVersion()) {
            is ApiResult.Ok -> {
                lastVerifyAt = now()
                val server = r.value
                when {
                    server == null -> { // server lost the profile: re-create from the local copy
                        log("Profile missing on server, re-uploading")
                        repo.update { it.copy(syncState = SyncState.PENDING, profileVersion = 0) }
                        put(repo.current, 0, retried = false)
                    }
                    server < rec.profileVersion -> {
                        log("Profile on server is older, re-uploading")
                        repo.update { it.copy(syncState = SyncState.PENDING, profileVersion = server) }
                        put(repo.current, server, retried = false)
                    }
                    else -> {
                        if (server > rec.profileVersion) repo.update { it.copy(profileVersion = server) }
                        ProfileSyncOutcome.Synced(server)
                    }
                }
            }
            is ApiResult.Failure -> failure(r, keepState = true)
        }
    }

    private fun put(rec: ProfileRecord, ifMatch: Int, retried: Boolean): ProfileSyncOutcome {
        val profile = rec.profile ?: return ProfileSyncOutcome.Idle
        val consent = rec.consent ?: return ProfileSyncOutcome.NeedsConsent
        val rev = rec.rev
        return when (val r = api.putProfile(profile.toInputJson(consent), ifMatch)) {
            is ApiResult.Ok -> {
                val version = r.value.profileVersion
                repo.update {
                    // an edit made while the request was in flight keeps the record PENDING (rev moved on)
                    if (it.profile == null) it
                    else it.copy(
                        profileVersion = version, lastSyncedAtMs = now(), attempts = 0, nextAttemptAtMs = 0, lastError = null,
                        syncState = if (it.rev == rev) SyncState.SYNCED else SyncState.PENDING,
                    )
                }
                lastVerifyAt = now()
                log("Profile synced (v$version)")
                ProfileSyncOutcome.Synced(version)
            }
            is ApiResult.Failure -> when {
                r.code == 409 && !retried -> resolveConflict(r, rev)
                r.code == 422 && isConsentError(r) -> consentRejected(rec)
                r.code == 422 -> { // fields the server refuses: needs an edit, not a retry
                    repo.update { it.copy(syncState = SyncState.FAILED, lastError = ERR_REJECTED, attempts = it.attempts + 1) }
                    ProfileSyncOutcome.Failed(ERR_REJECTED)
                }
                r.code == 404 -> { // device unknown to the server: register again on the next round
                    config.deviceId = null
                    failure(r, keepState = false)
                }
                else -> failure(r, keepState = false)
            }
        }
    }

    /** 409: another write won. Take the server's version as the new base and write again; local content wins. */
    private fun resolveConflict(f: ApiResult.Failure, rev: Int): ProfileSyncOutcome {
        val detailVersion = f.details?.let { if (it.has("profile_version")) it.optInt("profile_version", -1) else -1 } ?: -1
        val base: Int? = when (val g = api.getProfile()) {
            is ApiResult.Ok -> g.value.profileVersion
            is ApiResult.Failure -> if (g.code == 404) 0 else if (detailVersion >= 0) detailVersion else return failure(g, keepState = false)
        }
        log("Profile conflict resolved, retrying")
        val rec = repo.current
        if (rec.rev != rev) return ProfileSyncOutcome.Deferred // edited meanwhile: the next round uploads the newer data
        return put(rec, base ?: 0, retried = true)
    }

    private fun isConsentError(f: ApiResult.Failure): Boolean {
        val d = f.details ?: return false
        val fields = d.optJSONObject("fields") ?: d
        return fields.keys().asSequence().any { it.startsWith("consent") }
    }

    private fun consentRejected(rec: ProfileRecord): ProfileSyncOutcome {
        // refresh /server-info: the required consent version may simply be newer than the one the user accepted
        (api.serverInfo() as? ApiResult.Ok)?.let { config.update(it.value, now()) }
        val server = config.profileConsentVersion
        return if (server != null && server != rec.consent?.version) {
            repo.update { it.copy(syncState = SyncState.NEEDS_CONSENT, lastError = ERR_CONSENT) }
            ProfileSyncOutcome.NeedsConsent
        } else {
            repo.update { it.copy(syncState = SyncState.FAILED, lastError = ERR_REJECTED, attempts = it.attempts + 1) }
            ProfileSyncOutcome.Failed(ERR_REJECTED)
        }
    }

    private fun erase(rec: ProfileRecord, force: Boolean): ProfileSyncOutcome {
        if (!force && rec.nextAttemptAtMs > now()) return ProfileSyncOutcome.Deferred
        return when (val r = api.deleteProfile()) {
            is ApiResult.Ok -> done()
            is ApiResult.Failure -> if (r.code == 404) done() else {
                val wait = backoff(rec.attempts, r.retryAfterSeconds)
                repo.update { it.copy(attempts = it.attempts + 1, nextAttemptAtMs = now() + wait) }
                if (r.isNetwork) ProfileSyncOutcome.Offline else ProfileSyncOutcome.Failed(reasonOf(r))
            }
        }
    }

    private fun done(): ProfileSyncOutcome {
        repo.update { it.copy(pendingErase = false, attempts = 0, nextAttemptAtMs = 0) }
        log("Profile erased on server")
        return ProfileSyncOutcome.Erased
    }

    private fun failure(r: ApiResult.Failure, keepState: Boolean): ProfileSyncOutcome {
        val reason = reasonOf(r)
        val wait = backoff(repo.current.attempts, r.retryAfterSeconds)
        repo.update {
            it.copy(
                attempts = it.attempts + 1, nextAttemptAtMs = now() + wait,
                // offline / throttled stays "will sync when online"; real server errors show "sync failed"
                syncState = if (keepState) it.syncState else if (r.isNetwork || r.isRateLimited) SyncState.PENDING else SyncState.FAILED,
                lastError = if (keepState) it.lastError else reason,
            )
        }
        return if (r.isNetwork) ProfileSyncOutcome.Offline else ProfileSyncOutcome.Failed(reason)
    }

    private fun reasonOf(r: ApiResult.Failure) = when {
        r.isNetwork -> ERR_OFFLINE
        r.isRateLimited -> ERR_RATE_LIMITED
        r.code == 401 || r.code == 403 -> ERR_AUTH
        else -> ERR_SERVER
    }

    companion object {
        const val ERR_OFFLINE = "offline"
        const val ERR_RATE_LIMITED = "rate_limited"
        const val ERR_REJECTED = "rejected"
        const val ERR_SERVER = "server_error"
        const val ERR_AUTH = "auth"
        const val ERR_CONSENT = "consent"
        const val VERIFY_EVERY_MS = 15 * 60_000L
        private const val BASE_MS = 15_000L
        private const val MAX_MS = 30 * 60_000L

        /** 15 s, 30 s, 60 s ... capped at 30 min; a server `Retry-After` is a lower bound. */
        fun backoff(attempts: Int, retryAfterSeconds: Int? = null): Long {
            val exp = minOf(MAX_MS, BASE_MS shl minOf(attempts, 10))
            return maxOf(exp, (retryAfterSeconds ?: 0) * 1000L)
        }
    }
}
