import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Connects to `wss://{host}/v1/ws?token=<JWT>&client=app` for live responder event stream.
/// Server pushes frames: `{ "event": <name>, "data": <payload>, "ts": <rfc3339> }`.
/// Connection and 30-second ping keep responder presence fresh (`last_app_seen_at`).
public final class ResponderWebSocket {
    private let urlProvider: () -> URL?
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveTask: Task<Void, Never>?
    private var pingTimer: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var running = false

    public var onEvent: ((String, JSONValue) -> Void)?
    public var onStateChange: ((Bool) -> Void)?

    public init(urlProvider: @escaping () -> URL?) {
        self.urlProvider = urlProvider
    }

    public var isConnected: Bool { running && task != nil }

    public func connect() {
        guard !running else { return }
        running = true
        openSocket()
    }

    private func openSocket() {
        guard running, let url = urlProvider() else { return }
        let session = URLSession(configuration: .default)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        onStateChange?(true)
        startReceiving()
        startPing()
    }

    public func disconnect() {
        running = false
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        onStateChange?(false)
    }

    private func startReceiving() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.running, let task = self.task else { break }
                do {
                    let msg = try await task.receive()
                    switch msg {
                    case .string(let text):
                        self.handleMessage(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleMessage(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    self.handleFailure()
                    break
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let json = JSONValue.parse(text) else { return }
        let event = json.optString("event") ?? ""
        let data = json["data"] ?? .null
        onEvent?(event, data)
    }

    private func handleFailure() {
        guard running else { return }
        pingTimer?.cancel()
        pingTimer = nil
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        onStateChange?(false)

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard let self, self.running else { return }
            self.openSocket()
        }
    }

    private func startPing() {
        pingTimer?.cancel()
        pingTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, self.running, let task = self.task else { break }
                task.sendPing { _ in }
            }
        }
    }
}
