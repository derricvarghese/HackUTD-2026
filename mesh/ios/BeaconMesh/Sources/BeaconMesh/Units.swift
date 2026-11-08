import Foundation

/// The unit preference from Settings -> Units. Stored under `storageKey` in UserDefaults; default `automatic`.
public enum UnitPreference: String, CaseIterable, Sendable {
    case automatic, metric, imperial

    public static let storageKey = "beacon.units"

    /// Automatic follows the region: US and UK-style measurement systems get feet and miles, everything else metric.
    public func resolve(locale: LocaleMeasurement) -> UnitSystem {
        switch self {
        case .metric: return .metric
        case .imperial: return .imperial
        case .automatic:
            switch locale {
            case .metric: return .metric
            case .us, .uk: return .imperial
            }
        }
    }
}

/// The measurement system of the device region (`Locale.MeasurementSystem` on Apple platforms, mapped in the UI layer).
public enum LocaleMeasurement: Sendable {
    case metric, us, uk
}

/// What a value is shown in. Storage is always metric (centimetres for height, metres for distance).
public enum UnitSystem: String, CaseIterable, Sendable {
    case metric, imperial
}

/// All unit conversion and number formatting lives here so it can be unit tested on Linux.
///
/// Rounding: metres below 1000 are whole metres, then kilometres with one decimal. Feet below 528 (0.1 mile) are whole
/// feet, then miles with one decimal. Heights are whole centimetres, or feet and whole inches. `spoken` forms are for
/// VoiceOver ("5 feet 7 inches", "0.6 miles"); the visual forms are abbreviated ("5 ft 7 in").
public enum Units {
    public static let metersPerFoot = 0.3048
    public static let metersPerMile = 1609.344
    public static let centimetersPerInch = 2.54
    /// Feet and inches the height fields accept (30 to 260 cm is 1 ft 0 in to 8 ft 6 in).
    public static let feetRange = 1...8
    public static let inchesRange = 0...11

    // MARK: Distance and accuracy

    /// A distance in metres, e.g. "5 m", "1.2 km", "16 ft", "0.6 mi"; spoken "5 meters", "0.6 miles".
    public static func distance(meters: Double, system: UnitSystem, spoken: Bool = false, locale: Locale = .current) -> String {
        let m = meters.isFinite ? max(0, meters) : 0
        switch system {
        case .metric:
            if m.rounded() < 1000 {
                return quantity(m.rounded(), decimals: 0, one: "meter", many: "meters", abbr: "m", spoken: spoken, locale: locale)
            }
            return quantity(m / 1000, decimals: 1, one: "kilometer", many: "kilometers", abbr: "km", spoken: spoken, locale: locale)
        case .imperial:
            let feet = m / metersPerFoot
            if feet.rounded() < 528 {
                return quantity(feet.rounded(), decimals: 0, one: "foot", many: "feet", abbr: "ft", spoken: spoken, locale: locale)
            }
            return quantity(m / metersPerMile, decimals: 1, one: "mile", many: "miles", abbr: "mi", spoken: spoken, locale: locale)
        }
    }

    /// GPS accuracy radius in metres, shown the same way as a distance ("16 ft", caller adds "±" or "accurate to").
    public static func accuracy(meters: Double, system: UnitSystem, spoken: Bool = false, locale: Locale = .current) -> String {
        distance(meters: meters, system: system, spoken: spoken, locale: locale)
    }

    // MARK: Height

    /// A height stored in whole centimetres: "170 cm", or "5 ft 7 in" (spoken "5 feet 7 inches").
    public static func height(cm: Int, system: UnitSystem, spoken: Bool = false, locale: Locale = .current) -> String {
        switch system {
        case .metric:
            return quantity(Double(cm), decimals: 0, one: "centimeter", many: "centimeters", abbr: "cm", spoken: spoken, locale: locale)
        case .imperial:
            let (feet, inches) = feetAndInches(cm: cm)
            let f = number(Double(feet), decimals: 0, locale: locale)
            let i = number(Double(inches), decimals: 0, locale: locale)
            if spoken {
                return "\(f) \(feet == 1 ? "foot" : "feet") \(i) \(inches == 1 ? "inch" : "inches")"
            }
            return "\(f) ft \(i) in"
        }
    }

    /// Nearest whole inch, split into feet and inches: 170 cm is (5, 7), 30 cm is (1, 0).
    public static func feetAndInches(cm: Int) -> (feet: Int, inches: Int) {
        let totalInches = Int((Double(cm) / centimetersPerInch).rounded())
        return (totalInches / 12, totalInches % 12)
    }

    /// Feet and inches to whole centimetres, rounded to the nearest centimetre: (5, 7) is 170 cm.
    public static func centimeters(feet: Int, inches: Int) -> Int {
        centimeters(inches: Double(feet * 12 + inches))
    }

    static func centimeters(inches: Double) -> Int {
        Int((inches * centimetersPerInch).rounded())
    }

    /// Reads a typed height into centimetres, or nil. Accepts "170", "170 cm", "1.7 m", "5 ft 7 in", "5'7\"", "5'7",
    /// "5 7", "67 in" and "5 ft". A bare number is centimetres. Only values inside `ProfileLimits.heightRange` are accepted.
    public static func parseHeight(_ text: String) -> Int? {
        guard let parts = parts(text), !parts.isEmpty else { return nil }
        let cm: Double
        switch parts.count {
        case 1:
            let (value, unit) = parts[0]
            switch unit ?? "cm" {
            case "cm": cm = value
            case "m": cm = value * 100
            case "in": cm = value * centimetersPerInch
            case "ft": cm = value * 12 * centimetersPerInch
            default: return nil
            }
        case 2:
            let (feet, feetUnit) = parts[0]
            let (inches, inchesUnit) = parts[1]
            guard feetUnit == nil || feetUnit == "ft", inchesUnit == nil || inchesUnit == "in", (0..<12).contains(inches) else {
                return nil
            }
            cm = (feet * 12 + inches) * centimetersPerInch
        default:
            return nil
        }
        let rounded = Int(cm.rounded())
        return ProfileLimits.heightRange.contains(rounded) ? rounded : nil
    }

    // MARK: Helpers

    /// A quantity with its unit, the number localised and rounded half away from zero first.
    private static func quantity(_ value: Double, decimals: Int, one: String, many: String, abbr: String,
                                 spoken: Bool, locale: Locale) -> String {
        let scale = pow(10, Double(decimals))
        let rounded = (value * scale).rounded() / scale
        let text = number(rounded, decimals: decimals, locale: locale)
        if spoken { return "\(text) \(rounded == 1 ? one : many)" }
        return "\(text) \(abbr)"
    }

    private static func number(_ value: Double, decimals: Int, locale: Locale) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = decimals
        formatter.maximumFractionDigits = decimals
        formatter.usesGroupingSeparator = false
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(decimals)f", value)
    }

    private enum Piece {
        case number(Double)
        case word(String)
    }

    /// Splits "5'7\"" and "5 ft 7 in" into (value, canonical unit) pairs. Nil for anything that is not number-unit text.
    private static func parts(_ text: String) -> [(value: Double, unit: String?)]? {
        var pieces: [Piece] = []
        var digits = ""
        var letters = ""

        func flushDigits() -> Bool {
            guard !digits.isEmpty else { return true }
            guard let value = Double(digits) else { return false }
            pieces.append(.number(value))
            digits = ""
            return true
        }
        func flushLetters() {
            if !letters.isEmpty { pieces.append(.word(letters)); letters = "" }
        }

        for ch in text.lowercased() {
            if ch == "'" || ch == "\u{2019}" {
                guard flushDigits() else { return nil }
                flushLetters()
                pieces.append(.word("ft"))
            } else if ch == "\"" || ch == "\u{201D}" || ch == "\u{2033}" {
                guard flushDigits() else { return nil }
                flushLetters()
                pieces.append(.word("in"))
            } else if ch.isASCII && (ch.isNumber || ch == ".") {
                flushLetters()
                digits.append(ch)
            } else if ch.isLetter {
                guard flushDigits() else { return nil }
                letters.append(ch)
            } else {
                guard flushDigits() else { return nil }
                flushLetters()
            }
        }
        guard flushDigits() else { return nil }
        flushLetters()

        var parts: [(value: Double, unit: String?)] = []
        var i = 0
        while i < pieces.count {
            guard case .number(let value) = pieces[i] else { return nil }
            var unit: String?
            if i + 1 < pieces.count, case .word(let word) = pieces[i + 1] {
                guard let canonical = canonicalUnit(word) else { return nil }
                unit = canonical
                i += 1
            }
            parts.append((value, unit))
            i += 1
        }
        return parts
    }

    private static func canonicalUnit(_ word: String) -> String? {
        switch word {
        case "cm", "centimeter", "centimeters", "centimetre", "centimetres": return "cm"
        case "m", "meter", "meters", "metre", "metres": return "m"
        case "in", "inch", "inches": return "in"
        case "ft", "feet", "foot": return "ft"
        default: return nil
        }
    }
}
