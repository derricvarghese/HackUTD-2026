#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreLocation)
import BeaconMesh
import CoreLocation
import Foundation

/// UserDefaults keys for responder mode. Both default to off.
enum ResponderPrefs {
    /// Settings -> "Responder mode": shows the Responder tab. Off = the plain victim app.
    static let modeKey = "beacon.responderMode"
    /// "Share my location with dispatch". Only takes effect after a sign-in in the current app session.
    static let shareKey = "beacon.responder.shareLocation"
}

/// User-facing wording for location sharing, in one place.
enum ResponderShareText {
    static let chip = "Sharing your location"
    static let chipA11y = "Sharing your location with dispatch. Turn it off in the Responder tab."
    static let switchTitle = "Share my location with dispatch"
    static let availableTitle = "Available for assignments"
    static let availableFooter = "Dispatch only assigns new cases to responders who are available."
    static let rationaleTitle = "Share your location?"
    static let rationale = "Dispatch and other responders can see your position on the dashboard map while sharing is on. It stops when you turn it off, sign out or leave responder mode."
    static let rationaleConfirm = "Share location"
    static let denied = "Location access is off for Beacon. Turn it on in Settings to share your position."
    static let restricted = "Location access is restricted on this device (for example by Screen Time or a device profile), so your position can't be shared."
    static let revoked = "Location access was turned off, so sharing stopped."
    static let reduced = "Beacon only has your approximate location. Dispatch will see roughly where you are. Turn on Precise Location in Settings for better accuracy."
    static let needSignIn = "Sign in again to share your location."
    static let openSettings = "Open Settings"
}

/// Wraps `CLLocationManager` for responder sharing: When-In-Use only, no background updates. Separate from the
/// mesh's own manager so the victim app's location handling is untouched. Never logs coordinates.
@MainActor
final class ResponderLocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    var onFix: ((SharedPosition) -> Void)?
    var onAuthorizationChange: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 25
        manager.activityType = .other
    }

    var status: CLAuthorizationStatus { manager.authorizationStatus }
    var isAuthorized: Bool { status == .authorizedWhenInUse || status == .authorizedAlways }
    var isReducedAccuracy: Bool { manager.accuracyAuthorization == .reducedAccuracy }

    func requestWhenInUse() { manager.requestWhenInUseAuthorization() }
    func start() { manager.startUpdatingLocation() }
    func stop() { manager.stopUpdatingLocation() }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        let p = SharedPosition(lat: l.coordinate.latitude, lng: l.coordinate.longitude)
        Task { @MainActor in self.onFix?(p) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.onAuthorizationChange?() }
    }
}
#endif
