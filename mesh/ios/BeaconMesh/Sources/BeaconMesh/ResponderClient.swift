import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Security)
import Security
#endif

// First-responder side of the app: log in with a dashboard account (`POST /v1/auth/login`, JWT),
// list open cases (`GET /v1/sos`) and claim / advance them (`/v1/assignments`).
// Privacy (server-enforced): only the assigned responder gets the exact `location`; everyone else
// gets `approx_location`, the centre of a ~1 km grid cell, which the map draws as a circle.

public struct ResponderAccount: Equatable, Codable {
    public var id: String
    public var username: String
    public var name: String
    public var role: String
    /// "Available for assignments" as last known; nil when the server did not say (older stored logins).
    public var available: Bool?

    public init(id: String, username: String, name: String, role: String, available: Bool? = nil) {
        self.id = id; self.username = username; self.name = name; self.role = role; self.available = available
    }

    static func from(_ j: JSONValue?) -> ResponderAccount? {
        guard let j, let id = j.optString("id"), let username = j.optString("username") else { return nil }
        return ResponderAccount(id: id, username: username, name: j.optString("name") ?? username, role: j.optString("role") ?? "responder",
                                available: j["available"]?.boolValue)
    }
}

/// One open case from `GET /v1/sos`, flattened for the map.
public struct ResponderCase: Identifiable, Equatable {
    public var id: String
    /// Contract category: trapped, injured, need_water_meds, safe, other.
    public var category: String
    public var status: String
    public var score: Int
    public var channel: String
    public var approxLat: Double
    public var approxLng: Double
    public var radiusM: Double
    /// Exact GPS, present only when this responder holds the assignment (or is admin).
    public var exactLat: Double?
    public var exactLng: Double?
    public var text: String?
    public var peopleCount: Int?
    public var name: String?
    public var ageRange: String?
    public var flags: [String]
    public var silent: Bool
    public var lastHeardAt: Date?
    public var hopCount: Int?
    public var maxHops: Int?
    public var assignmentId: String?
    public var assignmentStatus: String?
    public var assigneeId: String?
    public var assigneeName: String?

    public var hasExactLocation: Bool { exactLat != nil && exactLng != nil }
    public var lat: Double { exactLat ?? approxLat }
    public var lng: Double { exactLng ?? approxLng }

    public static func from(_ j: JSONValue) -> ResponderCase? {
        guard let id = j.optString("id"),
              let approx = j["approx_location"],
              let alat = approx["lat"]?.doubleValue, let alng = approx["lng"]?.doubleValue else { return nil }
        let loc = j["location"]
        let profile = j["profile"]
        let assignment = j["assignment"]
        let hop = j["hop"]
        let name = profile?.optString("preferred_name").flatMap { $0.isEmpty ? nil : $0 } ?? profile?.optString("full_name")
        return ResponderCase(
            id: id,
            category: j.optString("category") ?? "other",
            status: j.optString("status") ?? "reported",
            score: j["score"]?.intValue ?? 0,
            channel: j.optString("channel") ?? "app",
            approxLat: alat, approxLng: alng,
            radiusM: approx["radius_m"]?.doubleValue ?? 1000,
            exactLat: loc?["lat"]?.doubleValue, exactLng: loc?["lng"]?.doubleValue,
            text: j.optString("text"),
            peopleCount: j["people_count"]?.intValue,
            name: name,
            ageRange: profile?.optString("age_range"),
            flags: profile?["vulnerability_flags"]?.arrayValue?.compactMap { $0.stringValue } ?? [],
            silent: j["silent"]?.boolValue ?? false,
            lastHeardAt: j.optString("last_heard_at").flatMap { Iso.parse($0) }.map { Date(timeIntervalSince1970: Double($0) / 1000) },
            hopCount: hop?["hop_count"]?.intValue, maxHops: hop?["max_hops"]?.intValue,
            assignmentId: assignment?.optString("id"),
            assignmentStatus: assignment?.optString("status"),
            assigneeId: assignment?.optString("responder_id"),
            assigneeName: assignment?.optString("responder_name"))
    }
}

/// Where the login survives app restarts. Keychain on device; in memory for tests.
public protocol ResponderTokenStoring: AnyObject {
    func load() -> ResponderTokens?
    func save(_ tokens: ResponderTokens?)
}

public struct ResponderTokens: Codable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var accessExpiresAtMs: Int64
    public var account: ResponderAccount
}

public final class InMemoryResponderTokenStore: ResponderTokenStoring {
    private var tokens: ResponderTokens?
    public init(_ tokens: ResponderTokens? = nil) { self.tokens = tokens }
    public func load() -> ResponderTokens? { tokens }
    public func save(_ tokens: ResponderTokens?) { self.tokens = tokens }
}

#if canImport(Security)
/// One Keychain generic-password item holding the token JSON (this device only, after first unlock).
public final class KeychainResponderTokenStore: ResponderTokenStoring {
    private static let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.beacon.mesh.responder",
        kSecAttrAccount as String: "tokens",
    ]

    public init() {}

    public func load() -> ResponderTokens? {
        var q = Self.base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(ResponderTokens.self, from: data)
    }

    public func save(_ tokens: ResponderTokens?) {
        SecItemDelete(Self.base as CFDictionary)
        guard let tokens, let data = try? JSONEncoder().encode(tokens) else { return }
        var add = Self.base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
#endif

public enum ResponderError: Error, Equatable {
    case badCredentials
    case signedOut
    case alreadyClaimed(by: String?)
    case forbidden
    case server(String)
    case offline(String)

    public var message: String {
        switch self {
        case .badCredentials: return "Wrong username or password."
        case .signedOut: return "Signed out. Log in again."
        case .alreadyClaimed(let by): return "Another responder already claimed this case\(by.map { " (\($0))" } ?? "")."
        case .forbidden: return "Your account can't do that."
        case .server(let m): return m
        case .offline(let m): return "Can't reach the server: \(m)"
        }
    }
}

public final class ResponderClient: ResponderLocationSending {
    public let baseURL: String
    private let http: HTTPTransport
    private let store: ResponderTokenStoring
    private let now: () -> Int64

    // Several things use one client at once (case polling, location sharing), so the tokens are lock-guarded and
    // a refresh is shared: refresh tokens rotate, and two parallel refreshes would sign the responder out.
    private let lock = NSLock()
    private var _tokens: ResponderTokens?
    private var refreshing: Task<ResponderTokens, Error>?
    public private(set) var tokens: ResponderTokens? {
        get { lock.lock(); defer { lock.unlock() }; return _tokens }
        set { lock.lock(); _tokens = newValue; lock.unlock() }
    }
    public var account: ResponderAccount? { tokens?.account }

    public init(baseURL: String, http: HTTPTransport = URLSessionTransport(), store: ResponderTokenStoring,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        var b = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        if b.hasSuffix("/v1") { b.removeLast(3) }
        self.baseURL = b
        self.http = http
        self.store = store
        self.now = now
        self.tokens = store.load()
    }

    // MARK: Auth

    @discardableResult
    public func login(username: String, password: String) async throws -> ResponderAccount {
        let body = JSONValue.object(["username": .string(username), "password": .string(password)])
        let (status, json) = try await send("POST", "/v1/auth/login", body: body, bearer: nil)
        if status == 401 || status == 422 { throw ResponderError.badCredentials }
        guard (200..<300).contains(status) else { throw Self.error(status, json) }
        return try adopt(json)
    }

    public func logout() async {
        if let access = tokens?.accessToken {
            _ = try? await send("POST", "/v1/auth/logout", body: .object([:]), bearer: access)
        }
        tokens = nil
        store.save(nil)
    }

    // MARK: Cases

    /// Open cases, highest priority first.
    public func openCases() async throws -> [ResponderCase] {
        let json = try await authed("GET", "/v1/sos", query: "status=reported,assigned,en_route,on_scene&sort=priority&limit=200")
        return json["data"]?.arrayValue?.compactMap(ResponderCase.from) ?? []
    }

    /// Claims a case; afterwards `openCases()` returns its exact location.
    @discardableResult
    public func claim(_ sosId: String) async throws -> String {
        let json = try await authed("POST", "/v1/assignments", body: .object(["sos_id": .string(sosId)]))
        guard let id = json.optString("id") else { throw ResponderError.server("No assignment id in response") }
        return id
    }

    /// Advances an assignment: en_route, on_scene, resolved (needs `outcome`), released.
    public func updateAssignment(_ id: String, status: String, outcome: String? = nil) async throws {
        var body: [String: JSONValue] = ["status": .string(status)]
        if let outcome { body["outcome"] = .string(outcome) }
        _ = try await authed("PATCH", "/v1/assignments/\(id)", body: .object(body))
    }

    // MARK: Own profile

    /// `PATCH /v1/responders/{id}` with `{location:{lat,lng}}`, or `{location:null}` to stop sharing and clear the
    /// stored position. Also refreshes the server's `last_seen_at`.
    public func sendLocation(_ position: SharedPosition?) async throws {
        let loc: JSONValue = position.map { .object(["lat": .double($0.lat), "lng": .double($0.lng)]) } ?? .null
        try await patchSelf(["location": loc])
    }

    /// `PATCH /v1/responders/{id}` `{available}`: whether dispatch may assign cases to this responder.
    public func setAvailable(_ available: Bool) async throws {
        try await patchSelf(["available": .bool(available)])
        if var t = tokens {
            t.account.available = available
            tokens = t
            store.save(t)
        }
    }

    /// `PUT /v1/auth/me/presence` `{state: "online" | "offline", client: "app"}`
    /// Mobile app keepalive: sends `online` on open / foreground and every 60 s, and `offline` on leaving.
    @discardableResult
    public func setPresence(state: String, client: String = "app") async throws -> ResponderAccount? {
        let body = JSONValue.object(["state": .string(state), "client": .string(client)])
        let json = try await authed("PUT", "/v1/auth/me/presence", body: body)
        if let account = ResponderAccount.from(json) {
            if var t = tokens {
                t.account = account
                tokens = t
                store.save(t)
            }
            return account
        }
        return tokens?.account
    }

    /// Constructs the live WebSocket URL for responders: `wss://{host}/v1/ws?token=<JWT>&client=app`.
    public func webSocketURL() -> URL? {
        guard let token = tokens?.accessToken else { return nil }
        var wsBase = baseURL
        if wsBase.hasPrefix("https://") {
            wsBase = "wss://" + wsBase.dropFirst("https://".count)
        } else if wsBase.hasPrefix("http://") {
            wsBase = "ws://" + wsBase.dropFirst("http://".count)
        }
        return URL(string: "\(wsBase)/v1/ws?token=\(token)&client=app")
    }

    // MARK: Images

    /// `GET /v1/sos/{sosId}/images`: returns photos metadata for an open case (assigned responder or admin).
    public func listCaseImages(sosId: String) async throws -> [CaseImageMeta] {
        let json = try await authed("GET", "/v1/sos/\(sosId)/images")
        return (json["data"]?.arrayValue ?? []).compactMap(CaseImageMeta.fromJSON)
    }

    /// `PUT /v1/sos/{sosId}/images/{imageId}`: uploads an on-scene photo for an assigned case.
    @discardableResult
    public func uploadCaseImage(sosId: String, imageId: String, data: Data, caption: String? = nil) async throws -> CaseImageMeta? {
        var query: String? = nil
        if let caption, !caption.isEmpty {
            let trimmed = String(caption.prefix(CaseImageUploadQueue.maxCaptionLength))
            if let escaped = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                query = "caption=\(escaped)"
            }
        }
        let (status, json) = try await authedData("PUT", "/v1/sos/\(sosId)/images/\(imageId)", query: query, data: data, contentType: "image/jpeg")
        guard status == 200 || status == 201 else { throw Self.error(status, json) }
        return CaseImageMeta.fromJSON(json)
    }

    private func patchSelf(_ fields: [String: JSONValue]) async throws {
        guard let id = tokens?.account.id else { throw ResponderError.signedOut }
        // The mobile app sends X-Beacon-Client: app on every PATCH /responders/{id} to refresh in_app presence.
        _ = try await authed("PATCH", "/v1/responders/\(id)", body: .object(fields), extraHeaders: ["X-Beacon-Client": "app"])
    }

    // MARK: Plumbing

    private func authed(_ method: String, _ path: String, query: String? = nil, body: JSONValue? = nil,
                        extraHeaders: [String: String] = [:]) async throws -> JSONValue {
        guard var t = tokens else { throw ResponderError.signedOut }
        if t.accessExpiresAtMs - 30_000 < now() { t = try await refresh(t) }
        var (status, json) = try await send(method, path, query: query, body: body, bearer: t.accessToken, extraHeaders: extraHeaders)
        if status == 401 {
            t = try await refresh(t)
            (status, json) = try await send(method, path, query: query, body: body, bearer: t.accessToken, extraHeaders: extraHeaders)
        }
        guard (200..<300).contains(status) else { throw Self.error(status, json) }
        return json
    }

    private func authedData(_ method: String, _ path: String, query: String? = nil, data: Data,
                            contentType: String, extraHeaders: [String: String] = [:]) async throws -> (Int, JSONValue) {
        guard var t = tokens else { throw ResponderError.signedOut }
        if t.accessExpiresAtMs - 30_000 < now() { t = try await refresh(t) }
        var res = try await sendRaw(method, path, query: query, bodyData: data, contentType: contentType, bearer: t.accessToken, extraHeaders: extraHeaders)
        if res.0 == 401 {
            t = try await refresh(t)
            res = try await sendRaw(method, path, query: query, bodyData: data, contentType: contentType, bearer: t.accessToken, extraHeaders: extraHeaders)
        }
        return res
    }

    private func refresh(_ t: ResponderTokens) async throws -> ResponderTokens {
        lock.lock()
        if let current = _tokens, current.accessToken != t.accessToken { lock.unlock(); return current } // already refreshed
        if let running = refreshing { lock.unlock(); return try await running.value }
        let task = Task { try await self.performRefresh(t) }
        refreshing = task
        lock.unlock()
        defer { lock.lock(); refreshing = nil; lock.unlock() }
        return try await task.value
    }

    private func performRefresh(_ t: ResponderTokens) async throws -> ResponderTokens {
        let (status, json) = try await send("POST", "/v1/auth/refresh", body: .object(["refresh_token": .string(t.refreshToken)]), bearer: nil)
        guard (200..<300).contains(status) else {
            if status == 401 || status == 422 { tokens = nil; store.save(nil); throw ResponderError.signedOut }
            throw Self.error(status, json)
        }
        _ = try adopt(json, fallbackAccount: t.account)
        guard let fresh = tokens else { throw ResponderError.signedOut }
        return fresh
    }

    private func adopt(_ json: JSONValue, fallbackAccount: ResponderAccount? = nil) throws -> ResponderAccount {
        guard let access = json.optString("access_token"), let refresh = json.optString("refresh_token"),
              let account = ResponderAccount.from(json["responder"]) ?? fallbackAccount else {
            throw ResponderError.server("Unexpected login response")
        }
        let ttl = Int64(json["expires_in"]?.intValue ?? 900) * 1000
        let t = ResponderTokens(accessToken: access, refreshToken: refresh, accessExpiresAtMs: now() + ttl, account: account)
        tokens = t
        store.save(t)
        return account
    }

    private static func error(_ status: Int, _ json: JSONValue) -> ResponderError {
        let message = json.optString("message")
        switch status {
        case 401: return .signedOut
        case 403: return .forbidden
        case 409: return .alreadyClaimed(by: json["details"]?.optString("responder_name"))
        default: return .server(message ?? "Server error \(status)")
        }
    }

    private func send(_ method: String, _ path: String, query: String? = nil, body: JSONValue?, bearer: String?,
                      extraHeaders: [String: String] = [:]) async throws -> (Int, JSONValue) {
        let data = body?.serializedData() ?? Data()
        let ct = data.isEmpty ? nil : "application/json"
        return try await sendRaw(method, path, query: query, bodyData: data, contentType: ct, bearer: bearer, extraHeaders: extraHeaders)
    }

    private func sendRaw(_ method: String, _ path: String, query: String? = nil, bodyData: Data, contentType: String?,
                         bearer: String?, extraHeaders: [String: String] = [:]) async throws -> (Int, JSONValue) {
        guard let url = URL(string: baseURL + path + (query.map { "?" + $0 } ?? "")) else { throw ResponderError.server("Bad server URL") }
        var headers = ["Accept": "application/json"]
        if let contentType, !bodyData.isEmpty { headers["Content-Type"] = contentType }
        if let bearer { headers["Authorization"] = "Bearer \(bearer)" }
        for (k, v) in extraHeaders { headers[k] = v }
        let resp: HTTPResponse
        do {
            resp = try await http.send(HTTPRequest(method: method, url: url, headers: headers, body: bodyData))
        } catch {
            throw ResponderError.offline(error.localizedDescription)
        }
        return (resp.status, JSONValue.parse(resp.data) ?? .object([:]))
    }
}
