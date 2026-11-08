import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPRequest {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data
}

public struct HTTPResponse {
    public var status: Int
    public var data: Data
    public var headers: [String: String]

    public init(status: Int, data: Data = Data(), headers: [String: String] = [:]) {
        self.status = status; self.data = data; self.headers = headers
    }
}

public protocol HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var r = URLRequest(url: request.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.httpMethod = request.method
        r.httpBody = request.body.isEmpty ? nil : request.body
        for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
        return try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: r) { data, response, error in
                if let error { cont.resume(throwing: error); return }
                guard let http = response as? HTTPURLResponse else { cont.resume(throwing: BackendError.transport("no response")); return }
                var headers: [String: String] = [:]
                for (k, v) in http.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k.lowercased()] = v } }
                cont.resume(returning: HTTPResponse(status: http.statusCode, data: data ?? Data(), headers: headers))
            }.resume()
        }
    }
}

public enum BackendError: Error, Equatable {
    case transport(String)
    /// Non-2xx. `code` is the contract `Error.code` (unauthorized, bad_signature, expired, rate_limited, ...).
    case http(status: Int, code: String?, retryAfterSeconds: Int?)
    case notRegistered
    case badResponse

    /// Worth retrying later with backoff (network trouble, 429, 5xx).
    public var isRetryable: Bool {
        switch self {
        case .transport: return true
        case .http(let s, _, _): return s == 429 || s >= 500
        default: return false
        }
    }
}

public struct BatchItemResult: Equatable {
    public var id: String
    public var status: String      // created | duplicate | rejected
    public var reason: String?
    public var sosId: String?
}

public struct BatchResponse {
    public var results: [BatchItemResult]
    public var receipts: [DeliveredReceipt]
    public var messages: [BackendMessage]
}

public struct HeartbeatReply: Equatable {
    public var nextInSeconds: Int?
    public var eventActive: Bool?
}

/// A check-in the user is asked to answer (from a mesh `checkin_request` or `GET /checkins/pending`).
public struct CheckinPrompt: Equatable, Identifiable {
    public var checkinId: String
    public var sosId: String
    public var message: String?
    public var deadlineAtMs: Int64?
    public var id: String { checkinId }

    public init(checkinId: String, sosId: String, message: String?, deadlineAtMs: Int64?) {
        self.checkinId = checkinId; self.sosId = sosId; self.message = message; self.deadlineAtMs = deadlineAtMs
    }

    public static func from(_ item: StoredBackend) -> CheckinPrompt? {
        guard case .message(let m) = item.payload, m.kind == "checkin_request", let cid = m.checkinId else { return nil }
        return CheckinPrompt(checkinId: cid, sosId: m.sosId, message: m.body.optString("message"),
                             deadlineAtMs: m.body.optString("deadline_at").flatMap(Iso.parse))
    }
}

/// Typed access to the Beacon REST API (openapi.yaml). All paths carry the `/v1` prefix; signed requests follow
/// server/src/http/security.ts exactly. The base URL is fixed at build time (https://hackutd.alecj.com).
public final class BackendClient {
    public let baseURL: String
    private let http: HTTPTransport
    private let signer: MeshSigner
    private let config: BackendConfig
    private let now: () -> Int64
    /// server time minus phone time, learned from /server-info, so a wrong phone clock does not break signed calls
    public private(set) var clockOffsetMs: Int64 = 0

    public init(baseURL: String, http: HTTPTransport, signer: MeshSigner, config: BackendConfig,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        var b = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        self.baseURL = b
        self.http = http
        self.signer = signer
        self.config = config
        self.now = now
    }

    // MARK: Public endpoints

    public func fetchServerInfo() async throws -> ServerInfo {
        let json = try await call("GET", "/v1/server-info", auth: false)
        let info = ServerInfo.fromJSON(json)
        if let server = info.serverTimeMs { clockOffsetMs = server - now() }
        config.update(info, nowMs: now())
        return info
    }

    /// POST /v1/devices. Idempotent on the public key. Stores and returns the device id.
    @discardableResult
    public func registerDevice(appVersion: String?, displayName: String? = nil) async throws -> String {
        var body: [String: JSONValue] = [
            "public_key": .string(signer.publicKeyBase64), "platform": .string(MeshProtocol.devicePlatform),
        ]
        if let appVersion { body["app_version"] = .string(appVersion) }
        if let displayName, !displayName.isEmpty { body["display_name"] = .string(String(displayName.prefix(60))) }
        let json = try await call("POST", "/v1/devices", body: .object(body), auth: false)
        guard let id = json.optString("id"), Uuid7.isUUID(id) else { throw BackendError.badResponse }
        config.deviceId = id
        return id
    }

    // MARK: Device-authenticated endpoints

    public func uploadBatch(_ messages: [StoredMessage]) async throws -> BatchResponse {
        let body = JSONValue.object(["envelopes": .array(messages.map { $0.envelope.toJSON() })])
        let json = try await call("POST", "/v1/sos/batch", body: body, auth: true)
        let results: [BatchItemResult] = (json["results"]?.arrayValue ?? []).compactMap { r in
            guard let id = r.optString("id"), let st = r.optString("status") else { return nil }
            return BatchItemResult(id: id, status: st, reason: r.optString("reason"), sosId: r.optString("sos_id"))
        }
        return BatchResponse(results: results,
                             receipts: (json["receipts"]?.arrayValue ?? []).compactMap(DeliveredReceipt.fromJSON),
                             messages: (json["messages"]?.arrayValue ?? []).compactMap(BackendMessage.fromJSON))
    }

    public func fetchOutbox(limit: Int = 200) async throws -> [BackendMessage] {
        let json = try await call("GET", "/v1/mesh/outbox", query: "limit=\(limit)", auth: true)
        return (json["data"]?.arrayValue ?? []).compactMap(BackendMessage.fromJSON)
    }

    /// POST /v1/sos for a phone that is online (channel `app`). Returns true when newly created (201), false on replay (200).
    public func createSos(id: String, category: String, own: OwnInfo, createdAtMs: Int64, apiCategory: String) async throws -> Bool {
        var b: [String: JSONValue] = [
            "id": .string(id), "channel": .string("app"), "category": .string(apiCategory),
            "created_at": .string(Iso.format(createdAtMs)),
        ]
        if let lat = own.lat { b["lat"] = .double(lat) }
        if let lng = own.lng { b["lng"] = .double(lng) }
        if let acc = own.accuracy, acc >= 0 { b["accuracy_m"] = .double((acc * 10).rounded() / 10) }
        if let t = own.text, !t.isEmpty { b["text"] = .string(String(t.prefix(1000))) }
        if let p = own.people, p >= 1 { b["people_count"] = .int(Int64(p)) }
        if category == Category.trapped.rawValue { b["trapped"] = .bool(true) }
        if category == Category.injured.rawValue || category == Category.medical.rawValue { b["injured"] = .bool(true) }
        let (status, _) = try await callRaw("POST", "/v1/sos", body: .object(b), auth: true)
        return status == 201
    }

    public func sosStatus(id: String) async throws -> SosStatus {
        let json = try await call("GET", "/v1/sos/\(id)/status", auth: true)
        guard let st = json.optString("status") else { throw BackendError.badResponse }
        return SosStatus(status: st, reachedResponders: json["reached_responders"]?.boolValue ?? true,
                         etaMinutes: json["eta_minutes"]?.intValue, message: json.optString("message"),
                         updatedAtMs: json.optString("updated_at").flatMap(Iso.parse) ?? now())
    }

    public func sendHeartbeat(_ body: JSONValue) async throws -> HeartbeatReply {
        let json = try await call("POST", "/v1/heartbeats", body: body, auth: true)
        return HeartbeatReply(nextInSeconds: json["next_heartbeat_in_seconds"]?.intValue, eventActive: json["event_active"]?.boolValue)
    }

    public func pendingCheckins() async throws -> [CheckinPrompt] {
        let json = try await call("GET", "/v1/checkins/pending", auth: true)
        return (json["data"]?.arrayValue ?? []).compactMap { c in
            guard let id = c.optString("id"), let sos = c.optString("sos_id") else { return nil }
            return CheckinPrompt(checkinId: id, sosId: sos, message: nil, deadlineAtMs: c.optString("deadline_at").flatMap(Iso.parse))
        }
    }

    /// PATCH /v1/checkins/{id}. `response`: ok | need_help | other.
    public func respondCheckin(id: String, response: String, text: String?) async throws {
        var b: [String: JSONValue] = ["response": .string(response), "responded_at": .string(Iso.format(adjustedNow()))]
        if let text, !text.isEmpty { b["text"] = .string(String(text.prefix(1000))) }
        _ = try await call("PATCH", "/v1/checkins/\(id)", body: .object(b), auth: true)
    }

    // MARK: Plumbing

    func adjustedNow() -> Int64 { now() + clockOffsetMs }

    /// Builds the signed request (exposed for tests).
    public func makeRequest(method: String, path: String, query: String? = nil, body: Data, auth: Bool) throws -> HTTPRequest {
        guard let url = URL(string: baseURL + path + (query.map { "?" + $0 } ?? "")) else { throw BackendError.badResponse }
        var headers = ["Accept": "application/json"]
        if !body.isEmpty { headers["Content-Type"] = "application/json" }
        if auth {
            guard let device = config.deviceId else { throw BackendError.notRegistered }
            // The signed path excludes the query string; the body bytes hashed are exactly the bytes sent.
            let h = try RequestSigner.headers(deviceId: device, signer: signer, method: method, path: path, body: body, nowMs: adjustedNow())
            headers.merge(h) { $1 }
        }
        return HTTPRequest(method: method.uppercased(), url: url, headers: headers, body: body)
    }

    private func call(_ method: String, _ path: String, query: String? = nil, body: JSONValue? = nil, auth: Bool) async throws -> JSONValue {
        try await callRaw(method, path, query: query, body: body, auth: auth).1
    }

    private func callRaw(_ method: String, _ path: String, query: String? = nil, body: JSONValue? = nil, auth: Bool) async throws -> (Int, JSONValue) {
        let req = try makeRequest(method: method, path: path, query: query, body: body?.serializedData() ?? Data(), auth: auth)
        let resp: HTTPResponse
        do { resp = try await http.send(req) } catch let e as BackendError { throw e } catch { throw BackendError.transport(error.localizedDescription) }
        guard (200..<300).contains(resp.status) else {
            let code = JSONValue.parse(resp.data)?.optString("code")
            if resp.status == 401, code == "unauthorized", auth { config.deviceId = nil }   // unknown device: register again
            throw BackendError.http(status: resp.status, code: code, retryAfterSeconds: resp.headers["retry-after"].flatMap { Int($0) })
        }
        return (resp.status, JSONValue.parse(resp.data) ?? .object([:]))
    }
}
