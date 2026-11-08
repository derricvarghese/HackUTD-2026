import Foundation

/// Minimal JSON model with deterministic parsing and the exact canonical encoding the Beacon backend signs
/// (server/src/crypto/canonical.ts, server/docs/crypto.md section 1). Written by hand so the result does not
/// depend on JSONSerialization / JSONEncoder behaviour, which differs between Apple platforms and Linux.
public enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: Accessors

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var intValue: Int? {
        switch self {
        case .int(let i): return Int(exactly: i)
        case .double(let d): return d == d.rounded() && abs(d) < 9e15 ? Int(d) : nil
        default: return nil
        }
    }
    public var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }
    public var isNull: Bool { if case .null = self { return true }; return false }

    /// String field that may be absent or null.
    public func optString(_ key: String) -> String? { self[key]?.stringValue }

    // MARK: Parse

    public static func parse(_ data: Data) -> JSONValue? {
        var p = JSONParser(bytes: [UInt8](data))
        return p.parseDocument()
    }

    public static func parse(_ text: String) -> JSONValue? { parse(Data(text.utf8)) }

    // MARK: Encode

    /// Canonical JSON: keys sorted by UTF-16 code unit, no whitespace, ECMAScript string and number formatting.
    /// Throws for NaN / infinity, like the server.
    public func canonical() throws -> String {
        var out = ""
        try write(into: &out)
        return out
    }

    /// Same encoding for transport (the server parses it back); non-finite numbers become null.
    public func serialized() -> String {
        (try? canonical()) ?? JSONValue.sanitized(self).serialized()
    }

    public func serializedData() -> Data { Data(serialized().utf8) }

    private static func sanitized(_ v: JSONValue) -> JSONValue {
        switch v {
        case .double(let d): return d.isFinite ? v : .null
        case .array(let a): return .array(a.map(sanitized))
        case .object(let o): return .object(o.mapValues(sanitized))
        default: return v
        }
    }

    private func write(into out: inout String) throws {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d): out += try JSCanonical.number(d)
        case .string(let s): JSCanonical.quote(s, into: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                try v.write(into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                JSCanonical.quote(k, into: &out)
                out += ":"
                try o[k]!.write(into: &out)
            }
            out += "}"
        }
    }
}

public struct CanonicalError: Error, Equatable { public let message: String }

/// ECMAScript `JSON.stringify` formatting rules.
enum JSCanonical {
    static func quote(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    let hex = String(u.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }

    /// ECMAScript Number::toString (the digits are Swift's shortest round-trip digits, which equal V8's).
    static func number(_ d: Double) throws -> String {
        guard d.isFinite else { throw CanonicalError(message: "non-finite number") }
        if d == 0 { return "0" }
        let negative = d < 0
        let (digits, n) = shortestDigits(abs(d))   // value = 0.DIGITS x 10^n
        let k = digits.count
        var s: String
        if k <= n && n <= 21 {
            s = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            s = String(digits[..<i]) + "." + String(digits[i...])
        } else if -6 < n && n <= 0 {
            s = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let exp = (e >= 0 ? "+" : "-") + String(abs(e))
            if k == 1 {
                s = digits + "e" + exp
            } else {
                s = String(digits.first!) + "." + String(digits.dropFirst()) + "e" + exp
            }
        }
        return negative ? "-" + s : s
    }

    /// Returns (digits without leading/trailing zeros, n) such that value = 0.digits x 10^n.
    static func shortestDigits(_ v: Double) -> (String, Int) {
        // Swift prints the shortest round-trip representation: "123.456", "1e-05", "1.2345e+20", "5e-324".
        let desc = "\(v)"
        var mantissa = desc
        var exp10 = 0
        if let eIdx = desc.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(desc[..<eIdx])
            exp10 = Int(desc[desc.index(after: eIdx)...].replacingOccurrences(of: "+", with: "")) ?? 0
        }
        var intPart = mantissa
        var fracPart = ""
        if let dot = mantissa.firstIndex(of: ".") {
            intPart = String(mantissa[..<dot])
            fracPart = String(mantissa[mantissa.index(after: dot)...])
        }
        var digits = intPart + fracPart
        var pointPos = intPart.count + exp10         // decimal point sits after `pointPos` digits
        // strip leading zeros
        while digits.hasPrefix("0") && digits.count > 1 { digits.removeFirst(); pointPos -= 1 }
        // strip trailing zeros
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        return (digits, pointPos)
    }
}

// MARK: - Parser

struct JSONParser {
    let bytes: [UInt8]
    var pos = 0
    var depth = 0

    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func parseDocument() -> JSONValue? {
        skipWS()
        guard let v = parseValue() else { return nil }
        skipWS()
        return pos == bytes.count ? v : nil
    }

    private mutating func skipWS() {
        while pos < bytes.count, bytes[pos] == 0x20 || bytes[pos] == 0x0A || bytes[pos] == 0x0D || bytes[pos] == 0x09 { pos += 1 }
    }

    private mutating func parseValue() -> JSONValue? {
        guard pos < bytes.count, depth < 64 else { return nil }
        switch bytes[pos] {
        case UInt8(ascii: "{"): return parseObject()
        case UInt8(ascii: "["): return parseArray()
        case UInt8(ascii: "\""): return parseString().map(JSONValue.string)
        case UInt8(ascii: "t"): return literal("true", .bool(true))
        case UInt8(ascii: "f"): return literal("false", .bool(false))
        case UInt8(ascii: "n"): return literal("null", .null)
        default: return parseNumber()
        }
    }

    private mutating func literal(_ word: String, _ value: JSONValue) -> JSONValue? {
        let w = Array(word.utf8)
        guard pos + w.count <= bytes.count, Array(bytes[pos..<pos + w.count]) == w else { return nil }
        pos += w.count
        return value
    }

    private mutating func parseNumber() -> JSONValue? {
        let start = pos
        var isFloat = false
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "-") { pos += 1 }
        while pos < bytes.count {
            let c = bytes[pos]
            if c >= 0x30 && c <= 0x39 { pos += 1 }
            else if c == UInt8(ascii: ".") || c == UInt8(ascii: "e") || c == UInt8(ascii: "E") || c == UInt8(ascii: "+") || c == UInt8(ascii: "-") {
                isFloat = true; pos += 1
            } else { break }
        }
        guard pos > start, let text = String(bytes: bytes[start..<pos], encoding: .utf8) else { return nil }
        if !isFloat, let i = Int64(text) { return .int(i) }
        guard let d = Double(text), d.isFinite else { return nil }
        return .double(d)
    }

    private mutating func parseString() -> String? {
        guard bytes[pos] == UInt8(ascii: "\"") else { return nil }
        pos += 1
        var out = [UInt8]()
        while pos < bytes.count {
            let c = bytes[pos]
            pos += 1
            if c == UInt8(ascii: "\"") { return String(bytes: out, encoding: .utf8) }
            if c < 0x20 { return nil }
            if c != UInt8(ascii: "\\") { out.append(c); continue }
            guard pos < bytes.count else { return nil }
            let e = bytes[pos]
            pos += 1
            switch e {
            case UInt8(ascii: "\""): out.append(0x22)
            case UInt8(ascii: "\\"): out.append(0x5C)
            case UInt8(ascii: "/"): out.append(0x2F)
            case UInt8(ascii: "b"): out.append(0x08)
            case UInt8(ascii: "f"): out.append(0x0C)
            case UInt8(ascii: "n"): out.append(0x0A)
            case UInt8(ascii: "r"): out.append(0x0D)
            case UInt8(ascii: "t"): out.append(0x09)
            case UInt8(ascii: "u"):
                guard var cp = hex4() else { return nil }
                if cp >= 0xD800 && cp < 0xDC00 {
                    if pos + 1 < bytes.count, bytes[pos] == UInt8(ascii: "\\"), bytes[pos + 1] == UInt8(ascii: "u") {
                        pos += 2
                        guard let lo = hex4() else { return nil }
                        if lo >= 0xDC00 && lo < 0xE000 { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00) } else { cp = 0xFFFD }
                    } else { cp = 0xFFFD }
                } else if cp >= 0xDC00 && cp < 0xE000 { cp = 0xFFFD }
                let scalar = Unicode.Scalar(cp) ?? "\u{FFFD}"
                out.append(contentsOf: Array(String(Character(scalar)).utf8))
            default: return nil
            }
        }
        return nil
    }

    private mutating func hex4() -> UInt32? {
        guard pos + 4 <= bytes.count else { return nil }
        var v: UInt32 = 0
        for _ in 0..<4 {
            let c = bytes[pos]
            pos += 1
            switch c {
            case 0x30...0x39: v = v << 4 | UInt32(c - 0x30)
            case 0x41...0x46: v = v << 4 | UInt32(c - 0x41 + 10)
            case 0x61...0x66: v = v << 4 | UInt32(c - 0x61 + 10)
            default: return nil
            }
        }
        return v
    }

    private mutating func parseArray() -> JSONValue? {
        pos += 1; depth += 1; defer { depth -= 1 }
        var items = [JSONValue]()
        skipWS()
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "]") { pos += 1; return .array(items) }
        while true {
            skipWS()
            guard let v = parseValue() else { return nil }
            items.append(v)
            skipWS()
            guard pos < bytes.count else { return nil }
            if bytes[pos] == UInt8(ascii: ",") { pos += 1; continue }
            if bytes[pos] == UInt8(ascii: "]") { pos += 1; return .array(items) }
            return nil
        }
    }

    private mutating func parseObject() -> JSONValue? {
        pos += 1; depth += 1; defer { depth -= 1 }
        var obj = [String: JSONValue]()
        skipWS()
        if pos < bytes.count, bytes[pos] == UInt8(ascii: "}") { pos += 1; return .object(obj) }
        while true {
            skipWS()
            guard pos < bytes.count, let key = parseString() else { return nil }
            skipWS()
            guard pos < bytes.count, bytes[pos] == UInt8(ascii: ":") else { return nil }
            pos += 1
            skipWS()
            guard let v = parseValue() else { return nil }
            obj[key] = v
            skipWS()
            guard pos < bytes.count else { return nil }
            if bytes[pos] == UInt8(ascii: ",") { pos += 1; continue }
            if bytes[pos] == UInt8(ascii: "}") { pos += 1; return .object(obj) }
            return nil
        }
    }
}
