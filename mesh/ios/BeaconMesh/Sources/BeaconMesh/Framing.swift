import Foundation

/// Splits envelopes into GATT-write-sized chunks and reassembles them. See PROTOCOL.md "Transport framing".
public enum Framing {
    public static let frameTypeEnvelope: UInt8 = 0x01
    public static let headerSize = 9
    public static let maxChunks = 64

    public static func chunk(_ payload: Data, transferId: UInt32, maxWriteLength: Int) -> [Data] {
        let dataPerChunk = max(1, maxWriteLength - headerSize)
        let count = max(1, (payload.count + dataPerChunk - 1) / dataPerChunk)
        precondition(count <= maxChunks, "envelope too large for mesh transport")
        var frames: [Data] = []
        frames.reserveCapacity(count)
        let bytes = [UInt8](payload)
        for index in 0..<count {
            var frame = Data(capacity: maxWriteLength)
            frame.append(frameTypeEnvelope)
            frame.append(contentsOf: withUnsafeBytes(of: transferId.bigEndian, Array.init))
            frame.append(contentsOf: withUnsafeBytes(of: UInt16(index).bigEndian, Array.init))
            frame.append(contentsOf: withUnsafeBytes(of: UInt16(count).bigEndian, Array.init))
            let start = index * dataPerChunk
            let end = min(start + dataPerChunk, bytes.count)
            if start < end { frame.append(contentsOf: bytes[start..<end]) }
            frames.append(frame)
        }
        return frames
    }
}

/// Reassembles chunks per (peer, transferId). Not thread-safe; use from one queue.
public final class Reassembler {
    private struct Partial {
        var chunks: [Data?]
        var received: Int
        var startedAt: Date
    }

    private var partials: [String: Partial] = [:]
    private let timeout: TimeInterval

    public init(timeout: TimeInterval = 30) {
        self.timeout = timeout
    }

    /// Returns the full payload when the last chunk of a transfer arrives.
    public func ingest(_ frame: Data, from peer: String, now: Date = Date()) -> Data? {
        purge(now: now)
        let b = [UInt8](frame)
        guard b.count >= Framing.headerSize, b[0] == Framing.frameTypeEnvelope else { return nil }
        let transferId = UInt32(b[1]) << 24 | UInt32(b[2]) << 16 | UInt32(b[3]) << 8 | UInt32(b[4])
        let index = Int(UInt16(b[5]) << 8 | UInt16(b[6]))
        let count = Int(UInt16(b[7]) << 8 | UInt16(b[8]))
        guard count >= 1, count <= Framing.maxChunks, index < count else { return nil }
        let data = Data(b[Framing.headerSize...])

        if count == 1 { return data }

        let key = "\(peer)#\(transferId)"
        var partial = partials[key] ?? Partial(chunks: Array(repeating: nil, count: count), received: 0, startedAt: now)
        guard partial.chunks.count == count else { partials[key] = nil; return nil }
        if partial.chunks[index] == nil {
            partial.chunks[index] = data
            partial.received += 1
        }
        if partial.received == count {
            partials[key] = nil
            return partial.chunks.reduce(into: Data()) { $0.append($1!) }
        }
        partials[key] = partial
        return nil
    }

    public func reset(peer: String) {
        partials = partials.filter { !$0.key.hasPrefix("\(peer)#") }
    }

    private func purge(now: Date) {
        partials = partials.filter { now.timeIntervalSince($0.value.startedAt) < timeout }
    }
}
