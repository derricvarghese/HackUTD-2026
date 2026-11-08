#if canImport(Network)
import Foundation
import Network

/// Apple glue around `GatewaySync`: watches connectivity (NWPathMonitor) and drives periodic sync cycles.
/// All callbacks arrive on the main queue.
public final class GatewayUploader {
    public let sync: GatewaySync
    public var onOnline: (() -> Void)?
    public var onChange: (() -> Void)?

    /// Demo switch: pretend there is no internet even when there is.
    public var forceOffline: Bool {
        get { sync.forceOffline }
        set {
            let was = isOnline
            sync.forceOffline = newValue
            if !was && isOnline { becameOnline() }
            onChange?()
        }
    }

    /// Internet reachable, not forced offline.
    public var isOnline: Bool { sync.isOnline }
    public var hasInternet: Bool { sync.reachable }

    private let monitor = NWPathMonitor()
    private var timer: Timer?

    public init(sync: GatewaySync) {
        self.sync = sync
        sync.hop = { work in DispatchQueue.main.async(execute: work) }
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let was = self.isOnline
                self.sync.reachable = path.status == .satisfied
                self.sync.interface = path.usesInterfaceType(.wifi) ? .wifi : path.usesInterfaceType(.cellular) ? .cellular
                    : path.status == .satisfied ? .other : .unknown
                if !was && self.isOnline { self.becameOnline() }
                self.onChange?()
            }
        }
    }

    public func start() {
        monitor.start(queue: DispatchQueue(label: "beacon.mesh.path"))
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.tick() }
    }

    public func stop() {
        monitor.cancel()
        timer?.invalidate()
    }

    /// Periodic work: sync (upload, outbox, statuses, check-ins), the automatic heartbeat when due, and unsent check-in replies.
    /// Also called from BLE callbacks, which is what keeps the app useful while backgrounded.
    public func tick() {
        sync.requestCycle()
        Task {
            await sync.heartbeatIfDue()
            await sync.flushCheckinReplies()
        }
    }

    public func syncNow() { sync.requestCycle(force: true) }

    private func becameOnline() {
        onOnline?()
        sync.requestHeartbeat()          // connectivity returned: tell the server right away
        sync.requestCycle(force: true)
    }

    deinit { monitor.cancel(); timer?.invalidate() }
}
#endif
