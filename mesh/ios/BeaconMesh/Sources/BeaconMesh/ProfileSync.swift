import Foundation

// Local profile record + the sync state machine. Platform independent (Linux-testable): storage sits behind
// `ProfileStoring`, the network behind `BackendClient` (and so `HTTPTransport`), time and threading behind closures,
// exactly like `GatewaySync`. Nothing in here logs profile content: log lines carry status codes and counters only.

/// Consent text version bundled in the app, used before /server-info has ever been fetched (offline first launch).
/// A different `ServerInfo.profile_consent_version` later makes the engine ask the user to re-consent.
public enum ProfileConsent {
    public static let bundledVersion = "2026-11-v1"
}

/// Everything persisted about the profile. `profile == nil` means "no profile on this phone".
public struct ProfileRecord: Equatable {
    public var profile: UserProfile?
    /// The profile as last acknowledged by the server (base for the 409 three-way merge).
    public var base: UserProfile?
    public var consentVersion: String?
    public var consentAcceptedAtMs: Int64 = 0
    /// Server `profile_version` we last saw; 0 = the server has none (or we never synced).
    public var serverVersion = 0
    /// Local changes not yet acknowledged.
    public var dirty = false
    /// Bumped on every local edit so a sync that finishes after a newer edit does not clear `dirty`.
    public var revision = 0
    /// The user erased the profile; the DELETE has not reached the server yet.
    public var deletePending = false
    /// The user explicitly chose not to create a profile (only offered when the server says it is not required).
    public var skipped = false
    /// The server's consent text version changed (or a 422 said so): ask the user again before syncing.
    public var needsConsent = false
    public var lastError: String?
    public var lastSyncedAtMs: Int64 = 0
    public var lastVerifiedAtMs: Int64 = 0
    /// Fresh install: we asked the server once whether it already holds a profile for this device (reinstall).
    public var adoptionChecked = false

    public init() {}

    public func toJSON() -> JSONValue {
        var o: [String: JSONValue] = [
            "v": .int(1), "server_version": .int(Int64(serverVersion)), "dirty": .bool(dirty), "revision": .int(Int64(revision)),
            "delete_pending": .bool(deletePending), "skipped": .bool(skipped), "needs_consent": .bool(needsConsent),
            "consent_at": .int(consentAcceptedAtMs), "synced_at": .int(lastSyncedAtMs), "verified_at": .int(lastVerifiedAtMs),
            "adoption_checked": .bool(adoptionChecked),
        ]
        if let profile { o["profile"] = .object(profile.fieldsJSON()) }
        if let base { o["base"] = .object(base.fieldsJSON()) }
        if let consentVersion { o["consent_version"] = .string(consentVersion) }
        if let lastError { o["last_error"] = .string(lastError) }
        return .object(o)
    }

    public static func fromJSON(_ j: JSONValue) -> ProfileRecord? {
        guard j.objectValue != nil else { return nil }
        var r = ProfileRecord()
        r.profile = j["profile"].flatMap(UserProfile.fromJSON)
        r.base = j["base"].flatMap(UserProfile.fromJSON)
        r.consentVersion = j.optString("consent_version")
        r.consentAcceptedAtMs = Int64(j["consent_at"]?.intValue ?? 0)
        r.serverVersion = j["server_version"]?.intValue ?? 0
        r.dirty = j["dirty"]?.boolValue ?? false
        r.revision = j["revision"]?.intValue ?? 0
        r.deletePending = j["delete_pending"]?.boolValue ?? false
        r.skipped = j["skipped"]?.boolValue ?? false
        r.needsConsent = j["needs_consent"]?.boolValue ?? false
        r.lastError = j.optString("last_error")
        r.lastSyncedAtMs = Int64(j["synced_at"]?.intValue ?? 0)
        r.lastVerifiedAtMs = Int64(j["verified_at"]?.intValue ?? 0)
        r.adoptionChecked = j["adoption_checked"]?.boolValue ?? false
        return r
    }
}

/// Where the record lives. The app uses the Keychain (`ProfileKeychainStore`); tests use memory.
public protocol ProfileStoring: AnyObject {
    func load() -> ProfileRecord?
    func save(_ record: ProfileRecord)
    func clear()
}

public final class MemoryProfileStore: ProfileStoring {
    public private(set) var saved: ProfileRecord?
    public private(set) var saves = 0
    public init(_ initial: ProfileRecord? = nil) { saved = initial }
    public func load() -> ProfileRecord? { saved }
    public func save(_ record: ProfileRecord) { saved = record; saves += 1 }
    public func clear() { saved = nil }
}

public enum ProfileSyncStatus: Equatable {
    /// No profile on this phone.
    case empty
    /// Saved locally, waiting for a connection or the next attempt.
    case pending
    /// The server holds exactly this version.
    case synced
    /// The last attempt failed (generic reason, no content); retried with backoff unless the server rejected the data.
    case failed(String)
    /// The consent text changed on the server: the user must accept again.
    case needsConsent
}

public final class ProfileSyncEngine {
    public let client: BackendClient
    public let config: BackendConfig
    private let store: ProfileStoring

    public var hop: (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) }
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    public var log: (String) -> Void = { _ in }
    /// Called (on `hop`'s queue) after any state change.
    public var onChange: (() -> Void)?
    /// Asks the gateway to run a cycle soon (the app wires this to `GatewaySync.requestCycle(force: true)`).
    public var requestGatewayCycle: (() -> Void)?

    public private(set) var record: ProfileRecord
    public private(set) var backoff = Backoff()
    public private(set) var nextAttemptAtMs: Int64 = 0
    /// The server rejected the data itself (422 with a matching consent version): do not retry until the user edits.
    public private(set) var rejected = false

    /// How often a synced profile is compared with `Device.profile_version`.
    public var verifyEveryMs: Int64 = 6 * 3_600_000

    public init(client: BackendClient, config: BackendConfig, store: ProfileStoring) {
        self.client = client
        self.config = config
        self.store = store
        self.record = store.load() ?? ProfileRecord()
    }

    private func main<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { c in hop { c.resume(returning: work()) } }
    }

    // MARK: Read side (main queue)

    public var profile: UserProfile? { record.profile }
    public var hasProfile: Bool { record.profile != nil }
    public var isDeleting: Bool { record.deletePending }

    public var status: ProfileSyncStatus {
        guard record.profile != nil else { return .empty }
        if record.needsConsent { return .needsConsent }
        if record.dirty { return record.lastError.map(ProfileSyncStatus.failed) ?? .pending }
        return .synced
    }

    /// Skipping is ALWAYS possible (SOS is never blocked by a missing profile), whatever `profileRequired` says.
    public var canSkip: Bool { true }
    /// Home nudge: shown while there is no profile (skipped or not) or the consent must be renewed, unless the user
    /// dismissed it in this session (UI state; it returns on the next launch).
    public func showsBanner(dismissedThisSession: Bool) -> Bool { shouldPromptToComplete && !dismissedThisSession }
    /// Tonal, more prominent nudge when the server wants every user to have a profile. Never blocks anything.
    public var nudgeIsProminent: Bool { profileRequired && record.profile == nil }

    /// Whether the server wants every user to create a profile. Unknown (never online) counts as required.
    public var profileRequired: Bool { config.profileRequired ?? true }
    /// Consent text version to show now: the server's if known, else the bundled one.
    public var consentVersion: String { config.profileConsentVersion ?? ProfileConsent.bundledVersion }

    /// The first-run flow is needed: no profile and no explicit skip.
    public var needsOnboarding: Bool { record.profile == nil && !record.skipped }
    /// Home banner: no profile (skipped or not), or the consent must be renewed.
    public var shouldPromptToComplete: Bool { record.profile == nil || record.needsConsent }

    /// `MeshPayload.profile_summary` for an offline SOS. Nil without a consented profile with a name.
    public func meshSummary() -> JSONValue? {
        guard let p = record.profile, record.consentVersion != nil, !record.needsConsent else { return nil }
        return ProfileSummary.build(p, profileVersion: record.serverVersion, nowYear: ProfileDerive.utcYear(ms: now()))
    }

    // MARK: Mutations (main queue)

    /// Validates and stores an edited/new profile, then asks for a sync. Returns the field issues (nothing is stored when non-empty).
    /// `consentVersion` is the text version the user just accepted (new profile) or the stored one (edit).
    @discardableResult
    public func save(_ p: UserProfile, consentVersion: String) -> [String: String] {
        let issues = ProfileValidation.validate(p, nowYear: ProfileDerive.utcYear(ms: now()))
        guard issues.isEmpty else { return issues }
        let cleaned = ProfileValidation.cleaned(p)
        var r = record
        let consentChanged = r.consentVersion != consentVersion || r.needsConsent
        if r.profile == cleaned && !consentChanged && !r.skipped { return [:] }
        r.profile = cleaned
        if consentChanged || r.consentAcceptedAtMs == 0 { r.consentVersion = consentVersion; r.consentAcceptedAtMs = now() }
        r.needsConsent = false
        r.skipped = false
        r.dirty = true
        r.revision += 1
        r.lastError = nil
        commit(r, resetBackoff: true)
        return [:]
    }

    /// The user accepted a newer consent text for the profile they already have.
    public func renewConsent(version: String) {
        guard record.profile != nil else { return }
        var r = record
        r.consentVersion = version
        r.consentAcceptedAtMs = now()
        r.needsConsent = false
        r.dirty = true
        r.revision += 1
        r.lastError = nil
        commit(r, resetBackoff: true)
    }

    /// "Skip for now" at any step. Records no consent and stores nothing; no profile_summary is ever sent.
    public func skip() {
        guard record.profile == nil else { return }
        var r = record
        r.skipped = true
        commit(r, resetBackoff: false, kick: false)
    }

    /// Erases the local copy at once and the server copy as soon as possible (retried until it succeeds).
    public func deleteProfile() {
        var r = ProfileRecord()
        r.deletePending = true
        r.skipped = true
        r.adoptionChecked = true
        r.revision = record.revision + 1
        commit(r, resetBackoff: true)
    }

    /// "Retry" button.
    public func retry() {
        var r = record
        r.lastError = nil
        commit(r, resetBackoff: true)
    }

    private func commit(_ r: ProfileRecord, resetBackoff: Bool, kick: Bool = true) {
        record = r
        store.save(r)
        if resetBackoff { backoff.succeed(); nextAttemptAtMs = 0; rejected = false }
        onChange?()
        if kick { requestGatewayCycle?() }
    }

    // MARK: Sync

    /// What the next cycle has to do, decided on the main queue.
    private enum Work { case none, delete, adopt, push, verify, consent }

    private func nextWork() -> Work {
        let r = record
        if now() < nextAttemptAtMs { return .none }
        if r.deletePending { return .delete }
        guard r.profile != nil else { return (!r.adoptionChecked && !r.skipped) ? .adopt : .none }
        if let v = config.profileConsentVersion, v != r.consentVersion, !r.needsConsent { return .consent }
        if r.needsConsent { return .none }
        if r.dirty { return rejected ? .none : .push }
        if now() - r.lastVerifiedAtMs > verifyEveryMs { return .verify }
        return .none
    }

    /// One pass. Never throws; failures set the backoff. Called by `GatewaySync.runCycle` while online and registered.
    public func runCycle() async {
        guard await main({ [self] in client_hasDevice }) else { return }
        var guardLoops = 0
        while guardLoops < 4 {
            guardLoops += 1
            let work = await main { [self] in nextWork() }
            do {
                switch work {
                case .none: return
                case .consent:
                    await main { [self] in var r = record; r.needsConsent = true; commit(r, resetBackoff: false, kick: false) }
                case .delete: try await doDelete()
                case .adopt: try await doAdopt()
                case .push: try await doPush()
                case .verify: try await doVerify()
                }
                await main { [self] in
                    backoff.succeed()
                    nextAttemptAtMs = 0
                }
            } catch {
                await main { [self] in fail(error) }
                return
            }
        }
    }

    private var client_hasDevice: Bool { config.deviceId != nil }

    private func describe(_ e: Error) -> String {
        switch e as? BackendError {
        case .http(let s, _, _)?: return "HTTP \(s)"
        case .transport?: return "no connection"
        case .notRegistered?: return "not registered"
        case .badResponse?: return "bad response"
        case nil: return "error"
        }
    }

    private func fail(_ error: Error) {
        var retry: Int?
        if let be = error as? BackendError, case .http(_, _, let ra) = be { retry = ra }
        let delay = backoff.fail(retryAfter: retry)
        nextAttemptAtMs = now() + Int64(delay) * 1000
        var r = record
        r.lastError = describe(error)
        record = r
        store.save(r)
        log("Profile sync failed (\(describe(error))); retry in \(delay) s")
        onChange?()
    }

    private func isHTTP(_ e: Error, _ status: Int) -> Bool {
        if let be = e as? BackendError, case .http(let s, _, _) = be { return s == status }
        return false
    }

    private func doDelete() async throws {
        try await client.deleteProfile()
        await main { [self] in
            var r = record
            r.deletePending = false
            commit(r, resetBackoff: false, kick: r.dirty)   // a profile created while the DELETE was pending goes out next
            log("Profile erased on the server")
        }
    }

    /// Fresh install with an existing device key: take over the server copy instead of asking again.
    private func doAdopt() async throws {
        do {
            let got = try await client.getProfile()
            await main { [self] in
                guard record.profile == nil, !record.deletePending, let p = got.profile else { return }
                var r = record
                r.profile = p; r.base = p; r.serverVersion = got.version; r.dirty = false; r.skipped = false
                r.consentVersion = got.consentVersion ?? ""
                r.consentAcceptedAtMs = got.consentAcceptedAtMs ?? now()
                r.needsConsent = got.consentVersion == nil
                r.lastSyncedAtMs = now(); r.lastVerifiedAtMs = now(); r.adoptionChecked = true; r.lastError = nil
                commit(r, resetBackoff: false, kick: false)
                log("Profile restored from the server")
            }
        } catch {
            guard isHTTP(error, 404) else { throw error }
            await main { [self] in var r = record; r.adoptionChecked = true; commit(r, resetBackoff: false, kick: false) }
        }
    }

    private struct Snapshot { var profile: UserProfile; var consentVersion: String; var acceptedAt: Int64; var serverVersion: Int; var revision: Int }

    private func snapshot() -> Snapshot? {
        guard let p = record.profile, let c = record.consentVersion else { return nil }
        return Snapshot(profile: p, consentVersion: c, acceptedAt: record.consentAcceptedAtMs, serverVersion: record.serverVersion, revision: record.revision)
    }

    private func doPush() async throws {
        for _ in 0..<3 {
            guard let snap = await main({ [self] in snapshot() }) else { return }
            let body = snap.profile.inputJSON(consent: ProfileConsentInfo(version: snap.consentVersion, acceptedAtMs: snap.acceptedAt))
            do {
                let res = try await client.putProfile(body, ifMatch: String(snap.serverVersion))
                await main { [self] in
                    var r = record
                    r.serverVersion = res.version
                    r.base = snap.profile
                    r.lastVerifiedAtMs = now()
                    r.lastError = nil
                    if r.revision == snap.revision { r.dirty = false; r.lastSyncedAtMs = now() }
                    commit(r, resetBackoff: false, kick: r.dirty)
                    log("Profile synced (v\(res.version), \(res.created ? "created" : "replaced"))")
                }
                return
            } catch let e as BackendError {
                if case .http(409, _, _) = e {
                    try await reconcileAfterConflict()
                    continue
                }
                if case .http(422, _, _) = e {
                    await main { [self] in handleValidationRejection() }
                    try await refreshInfoForConsent()
                    return
                }
                if case .http(404, _, _) = e { await main { [self] in config.deviceId = nil } }   // unknown device: the gateway registers it again
                throw e
            }
        }
    }

    private func refreshInfoForConsent() async throws {
        _ = try await client.fetchServerInfo()
        await main { [self] in
            if let v = config.profileConsentVersion, v != record.consentVersion {
                var r = record; r.needsConsent = true; rejected = false; commit(r, resetBackoff: false, kick: false)
            }
        }
    }

    private func handleValidationRejection() {
        // Either the consent version is stale (resolved by refreshInfoForConsent) or the data itself was refused.
        rejected = true
        var r = record
        r.lastError = "Server rejected the profile"
        record = r
        store.save(r)
        log("Profile rejected by the server (422)")
        onChange?()
    }

    /// 409: someone else wrote a newer version (another install of this device key). GET it, merge, and retry.
    private func reconcileAfterConflict() async throws {
        do {
            let got = try await client.getProfile()
            await main { [self] in
                guard let local = record.profile else { return }
                var r = record
                r.profile = got.profile.map { UserProfile.merge(local: local, base: r.base, server: $0) } ?? local
                r.serverVersion = got.version
                r.base = got.profile ?? r.base
                r.revision += 1
                r.dirty = true
                commit(r, resetBackoff: false, kick: false)
                log("Profile conflict (409): merged with server v\(got.version)")
            }
        } catch {
            guard isHTTP(error, 404) else { throw error }
            await main { [self] in var r = record; r.serverVersion = 0; r.base = nil; commit(r, resetBackoff: false, kick: false) }
        }
    }

    /// Compares `Device.profile_version` with ours (reinstall, regained signal, another phone with the same key).
    private func doVerify() async throws {
        let serverV = try await client.serverProfileVersion()
        let local = await main { [self] in record.serverVersion }
        if serverV == local {
            await main { [self] in var r = record; r.lastVerifiedAtMs = now(); commit(r, resetBackoff: false, kick: false) }
        } else if let serverV, serverV > local {
            let got = try await client.getProfile()
            await main { [self] in
                guard !record.dirty, let p = got.profile else { return }
                var r = record
                r.profile = p; r.base = p; r.serverVersion = got.version; r.lastVerifiedAtMs = now(); r.lastSyncedAtMs = now()
                commit(r, resetBackoff: false, kick: false)
                log("Profile updated from the server (v\(got.version))")
            }
        } else {
            // The server lost it (nil) or holds an older version: send ours again.
            await main { [self] in
                var r = record
                r.serverVersion = serverV ?? 0
                r.dirty = true
                r.revision += 1
                commit(r, resetBackoff: false, kick: false)
                log("Server profile missing or older: re-sending")
            }
        }
    }
}
