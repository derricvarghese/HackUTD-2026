import Foundation

/// RFC 3339 UTC timestamps without DateFormatter (identical output on every platform).
/// Envelopes carry the exact strings that were signed, so never reformat a received one.
public enum Iso {
    /// `2026-11-07T16:12:00.000Z`, the same shape as JavaScript's `Date.toISOString()`.
    public static func format(_ ms: Int64) -> String {
        var days = ms / 86_400_000
        var rem = ms % 86_400_000
        if rem < 0 { rem += 86_400_000; days -= 1 }
        let (y, m, d) = civil(fromDays: days)
        let h = rem / 3_600_000, mi = (rem / 60_000) % 60, s = (rem / 1000) % 60, milli = rem % 1000
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", Int(y), Int(m), Int(d), Int(h), Int(mi), Int(s), Int(milli))
    }

    /// Parses RFC 3339 (`Z` or `+hh:mm`, optional fraction). Returns epoch milliseconds.
    public static func parse(_ s: String) -> Int64? {
        let b = Array(s.utf8)
        func num(_ from: Int, _ len: Int) -> Int64? {
            guard from + len <= b.count else { return nil }
            var v: Int64 = 0
            for i in from..<from + len {
                guard b[i] >= 0x30 && b[i] <= 0x39 else { return nil }
                v = v * 10 + Int64(b[i] - 0x30)
            }
            return v
        }
        guard b.count >= 20, b[4] == 0x2D, b[7] == 0x2D, b[10] == 0x54 || b[10] == 0x74 || b[10] == 0x20,
              b[13] == 0x3A, b[16] == 0x3A,
              let y = num(0, 4), let mo = num(5, 2), let d = num(8, 2),
              let h = num(11, 2), let mi = num(14, 2), let sec = num(17, 2),
              (1...12).contains(mo), (1...31).contains(d), h < 24, mi < 60, sec < 61
        else { return nil }
        var i = 19
        var milli: Int64 = 0
        if b[i] == 0x2E {
            i += 1
            var digits = 0
            var frac: Int64 = 0
            while i < b.count, b[i] >= 0x30, b[i] <= 0x39 {
                if digits < 3 { frac = frac * 10 + Int64(b[i] - 0x30); digits += 1 }
                i += 1
            }
            guard digits > 0 else { return nil }
            while digits < 3 { frac *= 10; digits += 1 }
            milli = frac
        }
        var offsetMin: Int64 = 0
        guard i < b.count else { return nil }
        if b[i] == 0x5A || b[i] == 0x7A {
            guard i + 1 == b.count else { return nil }
        } else if b[i] == 0x2B || b[i] == 0x2D {
            guard let oh = num(i + 1, 2), b.count > i + 3, b[i + 3] == 0x3A, let om = num(i + 4, 2), i + 6 == b.count else { return nil }
            offsetMin = (oh * 60 + om) * (b[i] == 0x2D ? -1 : 1)
        } else { return nil }
        let days = daysFromCivil(y, mo, d)
        return ((days * 24 + h) * 60 + mi - offsetMin) * 60_000 + sec * 1000 + milli
    }

    // Howard Hinnant's civil-date algorithms.
    static func daysFromCivil(_ y0: Int64, _ m: Int64, _ d: Int64) -> Int64 {
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func civil(fromDays z0: Int64) -> (Int64, Int64, Int64) {
        let z = z0 + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        return (m <= 2 ? y + 1 : y, m, d)
    }
}

/// UUIDv7 (RFC 9562): 48-bit unix ms + random. Same layout as server/src/testing/uuid.ts.
public enum Uuid7 {
    public static func generate(nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
        var b = [UInt8](repeating: 0, count: 16)
        for i in 6..<16 { b[i] = UInt8.random(in: 0...255) }
        for i in 0..<6 { b[i] = UInt8(truncatingIfNeeded: nowMs >> Int64(8 * (5 - i))) }
        b[6] = (b[6] & 0x0F) | 0x70
        b[8] = (b[8] & 0x3F) | 0x80
        let h = b.map { String(format: "%02x", $0) }.joined()
        let c = Array(h)
        func s(_ a: Int, _ z: Int) -> String { String(c[a..<z]) }
        return "\(s(0, 8))-\(s(8, 12))-\(s(12, 16))-\(s(16, 20))-\(s(20, 32))"
    }

    public static func isUUID(_ s: String) -> Bool {
        let c = Array(s.utf8)
        guard c.count == 36 else { return false }
        for (i, ch) in c.enumerated() {
            if [8, 13, 18, 23].contains(i) { if ch != 0x2D { return false } }
            else if !((ch >= 0x30 && ch <= 0x39) || (ch >= 0x61 && ch <= 0x66) || (ch >= 0x41 && ch <= 0x46)) { return false }
        }
        return true
    }
}
