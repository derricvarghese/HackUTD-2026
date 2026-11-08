import Foundation

/// Metadata of one photo attached to an SOS case, matching the OpenAPI `CaseImage` schema.
public struct CaseImageMeta: Equatable, Identifiable, Codable {
    public var id: String
    public var contentType: String
    public var bytes: Int
    public var width: Int
    public var height: Int
    public var caption: String?
    public var uploadedByKind: String
    public var responderName: String?
    public var createdAt: String

    public init(id: String, contentType: String, bytes: Int, width: Int, height: Int,
                caption: String? = nil, uploadedByKind: String = "device", responderName: String? = nil,
                createdAt: String = "") {
        self.id = id
        self.contentType = contentType
        self.bytes = bytes
        self.width = width
        self.height = height
        self.caption = caption
        self.uploadedByKind = uploadedByKind
        self.responderName = responderName
        self.createdAt = createdAt
    }

    public static func fromJSON(_ j: JSONValue) -> CaseImageMeta? {
        guard let id = j.optString("id"),
              let contentType = j.optString("content_type"),
              let bytes = j["bytes"]?.intValue,
              let width = j["width"]?.intValue,
              let height = j["height"]?.intValue else { return nil }
        let uploadedBy = j["uploaded_by"]
        return CaseImageMeta(
            id: id,
            contentType: contentType,
            bytes: bytes,
            width: width,
            height: height,
            caption: j.optString("caption"),
            uploadedByKind: uploadedBy?.optString("kind") ?? "device",
            responderName: uploadedBy?.optString("responder_name"),
            createdAt: j.optString("created_at") ?? ""
        )
    }
}

/// One photo queued offline for upload once internet connectivity is restored.
public struct QueuedImage: Codable, Equatable, Identifiable {
    public var id: String
    public var sosId: String
    public var data: Data
    public var caption: String?
    public var createdAtMs: Int64
    public var attempts: Int
    public var nextRetryMs: Int64

    public init(id: String = UUID().uuidString.lowercased(),
                sosId: String,
                data: Data,
                caption: String? = nil,
                createdAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
                attempts: Int = 0,
                nextRetryMs: Int64 = 0) {
        self.id = id
        self.sosId = sosId
        self.data = data
        self.caption = caption.flatMap { s in
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : String(trimmed.prefix(CaseImageUploadQueue.maxCaptionLength))
        }
        self.createdAtMs = createdAtMs
        self.attempts = attempts
        self.nextRetryMs = nextRetryMs
    }
}

public protocol CaseImageStoring: AnyObject {
    func loadAll() -> [QueuedImage]
    func saveAll(_ images: [QueuedImage])
}

public final class InMemoryCaseImageStore: CaseImageStoring {
    private var images: [QueuedImage]
    private let lock = NSLock()

    public init(_ initial: [QueuedImage] = []) {
        self.images = initial
    }

    public func loadAll() -> [QueuedImage] {
        lock.lock()
        defer { lock.unlock() }
        return images
    }

    public func saveAll(_ images: [QueuedImage]) {
        lock.lock()
        self.images = images
        lock.unlock()
    }
}

/// Disk persistence for queued images in Application Support.
public final class DiskCaseImageStore: CaseImageStoring {
    private let fileURL: URL
    private let lock = NSLock()

    public init(directoryURL: URL? = nil) {
        let dir = directoryURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        self.fileURL = dir.appendingPathComponent("beacon_case_images.json")
    }

    public func loadAll() -> [QueuedImage] {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: fileURL),
              let list = try? JSONDecoder().decode([QueuedImage].self, from: data) else {
            return []
        }
        return list
    }

    public func saveAll(_ images: [QueuedImage]) {
        lock.lock()
        defer { lock.unlock() }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if images.isEmpty {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        if let data = try? JSONEncoder().encode(images) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}

public enum UploadImageResult: Equatable {
    case success(CaseImageMeta?)
    case drop(status: Int, message: String?)
    case retry(afterSeconds: Int?)
}

public enum CaseImageError: Error, Equatable {
    case maxImagesReached(max: Int)
    case emptyData
}

/// Offline retry queue for case photo uploads. Enforces maximum 6 photos per case,
/// 200-character caption limit, client-generated UUIDs, and exponential backoff retry.
public final class CaseImageUploadQueue {
    public static let maxPerCase = 6
    public static let maxCaptionLength = 200

    private let store: CaseImageStoring
    private let now: () -> Int64
    private let lock = NSLock()
    private var images: [QueuedImage]

    public init(store: CaseImageStoring, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.store = store
        self.now = now
        self.images = store.loadAll()
    }

    public func queuedCount(for sosId: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return images.filter { $0.sosId == sosId }.count
    }

    public func queuedImages(for sosId: String) -> [QueuedImage] {
        lock.lock()
        defer { lock.unlock() }
        return images.filter { $0.sosId == sosId }
    }

    public func allPending() -> [QueuedImage] {
        lock.lock()
        defer { lock.unlock() }
        return images
    }

    @discardableResult
    public func enqueue(sosId: String, data: Data, caption: String? = nil, id: String = UUID().uuidString.lowercased()) throws -> QueuedImage {
        guard !data.isEmpty else { throw CaseImageError.emptyData }
        lock.lock()
        defer { lock.unlock() }
        let existing = images.filter { $0.sosId == sosId }.count
        guard existing < Self.maxPerCase else {
            throw CaseImageError.maxImagesReached(max: Self.maxPerCase)
        }
        let item = QueuedImage(id: id, sosId: sosId, data: data, caption: caption, createdAtMs: now())
        images.append(item)
        store.saveAll(images)
        return item
    }

    public func remove(id: String) {
        lock.lock()
        images.removeAll { $0.id == id }
        store.saveAll(images)
        lock.unlock()
    }

    public func reset() {
        lock.lock()
        images.removeAll()
        store.saveAll(images)
        lock.unlock()
    }

    private func recordRetry(id: String, retryAfter: Int?) {
        lock.lock()
        defer { lock.unlock() }
        guard let idx = images.firstIndex(where: { $0.id == id }) else { return }
        var updated = images[idx]
        updated.attempts += 1
        let shift = Int64(min(updated.attempts - 1, 6))
        let delayMs: Int64 = max(Int64(retryAfter ?? 0) * 1000, min(10_000 << shift, 300_000))
        updated.nextRetryMs = now() + delayMs
        images[idx] = updated
        store.saveAll(images)
    }

    /// Attempts to upload all pending images that are due.
    /// Returns the number of images successfully uploaded.
    public func flush(using uploader: (QueuedImage) async throws -> UploadImageResult) async -> Int {
        let t = now()
        lock.lock()
        let due = images.filter { $0.nextRetryMs <= t }
        lock.unlock()

        var uploadedCount = 0
        for item in due {
            do {
                let res = try await uploader(item)
                switch res {
                case .success:
                    uploadedCount += 1
                    remove(id: item.id)
                case .drop:
                    remove(id: item.id)
                case .retry(let ra):
                    recordRetry(id: item.id, retryAfter: ra)
                }
            } catch {
                recordRetry(id: item.id, retryAfter: nil)
            }
        }
        return uploadedCount
    }
}
