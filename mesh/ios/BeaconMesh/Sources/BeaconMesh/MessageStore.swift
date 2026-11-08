import Foundation

public struct StoredMessage: Codable, Equatable, Identifiable {
    public var id: String
    /// The envelope exactly as received (or as created, with hop 0, for our own messages).
    public var envelope: Envelope
    public var header: SignedHeader
    public var receivedAt: Int64
    public var uploaded: Bool
    public var isOwn: Bool
    public var fromPeer: String?

    public var canForward: Bool { envelope.hop < header.maxHops }
}

public protocol MessageStore: AnyObject {
    func contains(_ id: String) -> Bool
    func save(_ message: StoredMessage)
    func all() -> [StoredMessage]
    func markUploaded(_ id: String)
    func deleteExpired(nowMs: Int64)
}

public final class InMemoryMessageStore: MessageStore {
    private var messages: [String: StoredMessage] = [:]
    public init() {}

    public func contains(_ id: String) -> Bool { messages[id] != nil }
    public func save(_ message: StoredMessage) { messages[message.id] = message }
    public func all() -> [StoredMessage] { messages.values.sorted { $0.receivedAt < $1.receivedAt } }
    public func markUploaded(_ id: String) { messages[id]?.uploaded = true }
    public func deleteExpired(nowMs: Int64) { messages = messages.filter { $0.value.header.expiresAt >= nowMs } }
}

/// Small JSON-file store. A hackathon mesh holds tens of messages, so rewriting the file is fine.
public final class FileMessageStore: MessageStore {
    private let url: URL
    private var memory = InMemoryMessageStore()

    public init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let list = try? JSONDecoder().decode([StoredMessage].self, from: data) {
            list.forEach(memory.save)
        }
    }

    public static func defaultStore() -> FileMessageStore {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return FileMessageStore(url: dir.appendingPathComponent("beacon-mesh-messages.json"))
    }

    public func contains(_ id: String) -> Bool { memory.contains(id) }
    public func save(_ message: StoredMessage) { memory.save(message); flush() }
    public func all() -> [StoredMessage] { memory.all() }
    public func markUploaded(_ id: String) { memory.markUploaded(id); flush() }
    public func deleteExpired(nowMs: Int64) { memory.deleteExpired(nowMs: nowMs); flush() }

    private func flush() {
        guard let data = try? JSONEncoder().encode(memory.all()) else { return }
        #if os(iOS)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: url, options: .atomic)
        #endif
    }
}
