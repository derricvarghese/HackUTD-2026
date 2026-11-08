import Foundation
import Network

/// Watches connectivity and POSTs held envelopes to the backend when this phone is a gateway.
public final class GatewayUploader {
    public var backendURL: URL?
    /// Demo switch: pretend there is no internet even when there is.
    public var forceOffline = false {
        didSet { if oldValue && !forceOffline && pathOnline { onOnline?() } }
    }
    public var onOnline: (() -> Void)?
    public var onUploaded: ((String) -> Void)?
    public var log: (String) -> Void = { _ in }

    public var isOnline: Bool { pathOnline && !forceOffline && backendURL != nil }

    private let monitor = NWPathMonitor()
    private var pathOnline = false
    private var inFlight = Set<String>()
    private let relayId: String

    public init(relayId: String, backendURL: URL?) {
        self.relayId = relayId
        self.backendURL = backendURL
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let was = self.isOnline
                self.pathOnline = path.status == .satisfied
                if !was && self.isOnline { self.onOnline?() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "beacon.mesh.path"))
    }

    deinit { monitor.cancel() }

    /// Call on the main queue.
    public func upload(_ msg: StoredMessage) {
        guard let base = backendURL, !inFlight.contains(msg.id), !msg.uploaded else { return }
        guard let envelopeObj = try? JSONSerialization.jsonObject(with: msg.envelope.jsonData()) else { return }
        let body: [String: Any] = [
            "envelope": envelopeObj,
            "gateway": relayId,
            "receivedAt": msg.receivedAt,
        ]
        var req = URLRequest(url: base.appendingPathComponent("api/mesh/ingest"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 15
        inFlight.insert(msg.id)
        URLSession.shared.dataTask(with: req) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.inFlight.remove(msg.id)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(code) {
                    self.log("UPLOAD \(msg.id.prefix(8)) ok")
                    self.onUploaded?(msg.id)
                } else {
                    self.log("UPLOAD \(msg.id.prefix(8)) failed: \(error?.localizedDescription ?? "HTTP \(code)")")
                }
            }
        }.resume()
    }
}
