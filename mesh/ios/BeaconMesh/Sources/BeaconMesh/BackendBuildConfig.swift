import Foundation

/// Build-time backend settings. Values come from Info.plist (filled from Xcode build settings):
///  - BEACON_BACKEND_URL (default https://hackutd.alecj.com), shown read-only in the app, not user editable
///  - BEACON_ENC_PUBLIC_KEY / BEACON_SIGN_PUBLIC_KEY: base64 X.509 SPKI keys from the server's `npm run keys`,
///    so a phone that has never been online can still encrypt (the cached /server-info key replaces them).
public enum BackendBuildConfig {
    public static let defaultURL = "https://hackutd.alecj.com"
    /// Public halves of the deployed backend keys (same defaults as the Android build). Override with the build settings.
    public static let defaultEncryptionPublicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMKGYDLIFVk9bEqFdel5jbq+OcWTtyQfiZTJMlbljEds6UY01Dkmvu3aSnQpuRgSs0o3KXGMjMZ7pouXIAL8Pjg=="
    public static let defaultSigningPublicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbRUn5miioijHsPNvV2egclM2qvrfhVSwXdzT+smBijGXuqwsH8hUdFvMhQRJ7hy/l/LgoixrqtQDdbU6gKwExQ=="

    public static func value(_ key: String, in info: [String: Any]? = Bundle.main.infoDictionary) -> String {
        guard let s = (info?[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty, !s.hasPrefix("$(") else { return "" }   // unresolved build setting
        return s
    }

    public static var backendURL: String {
        let v = value("BEACON_BACKEND_URL")
        return v.isEmpty ? defaultURL : v
    }
    public static var encryptionPublicKey: String {
        let v = value("BEACON_ENC_PUBLIC_KEY")
        return v.isEmpty ? defaultEncryptionPublicKey : v
    }
    public static var signingPublicKey: String {
        let v = value("BEACON_SIGN_PUBLIC_KEY")
        return v.isEmpty ? defaultSigningPublicKey : v
    }

    /// Host only, for the read-only server line in the UI.
    public static var backendHost: String { URL(string: backendURL)?.host ?? backendURL }
}
