#if canImport(UIKit) && canImport(SwiftUI)
import BeaconMesh
import Foundation

/// Glue between the pure `Units` logic and the device: the stored Settings choice and the region's measurement system.
/// Apple-only (uses `Locale.measurementSystem`, iOS 16+); all conversion itself lives in `Units` in BeaconMesh.
enum UnitSettings {
    /// The system to show right now for a stored `UnitPreference` raw value (`@AppStorage` string).
    static func system(for stored: String) -> UnitSystem {
        (UnitPreference(rawValue: stored) ?? .automatic).resolve(locale: localeMeasurement)
    }

    /// Same as `system(for:)` with the value read from UserDefaults, for code that is not a SwiftUI view.
    static var current: UnitSystem {
        system(for: UserDefaults.standard.string(forKey: UnitPreference.storageKey) ?? UnitPreference.automatic.rawValue)
    }

    static var localeMeasurement: LocaleMeasurement {
        let system = Locale.current.measurementSystem
        if system == .us { return .us }
        if system == .uk { return .uk }
        return .metric
    }
}

extension UnitPreference {
    /// Label in Settings -> Units.
    var title: String {
        switch self {
        case .automatic: return "Automatic"
        case .metric: return "Metric"
        case .imperial: return "Imperial"
        }
    }
}
#endif
