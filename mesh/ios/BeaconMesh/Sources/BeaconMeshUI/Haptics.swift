#if canImport(UIKit) && canImport(SwiftUI)
import BeaconMesh
import CoreHaptics
import Foundation
import SwiftUI
import UIKit

/// Semantic haptic events. Every interaction in the app goes through `Haptics.shared.play(_:)`.
public enum HapticEvent: CaseIterable {
    case tap, toggle, select, tick, success, warning, error, sheetOpen, sheetDismiss, holdCancel, send
}

/// The one place that produces haptics. A master switch (`enabled`, persisted) silences everything, including the
/// hold-to-send ramp. Standard events use the UIKit feedback generators; the hold-to-send ramp and the send pop use
/// CoreHaptics when the hardware supports it and fall back to UIKit generators otherwise.
/// Use from the main thread.
public final class Haptics: ObservableObject {
    public static let shared = Haptics()

    private static let key = "beacon.haptics"

    @Published public var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: Self.key)
            if !enabled { stopHoldPlayback() }
        }
    }

    /// True when CoreHaptics can drive the ramp; false means the UIKit fallback is in use.
    public let usesCoreHaptics: Bool

    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private let selection = UISelectionFeedbackGenerator()
    private let notification = UINotificationFeedbackGenerator()

    private var lastFired: [HapticEvent: Date] = [:]
    private var engine: CHHapticEngine?
    private var holdPlayer: CHHapticPatternPlayer?
    private var fallbackTimer: Timer?
    private var holdStartedAt: Date?

    private init() {
        enabled = UserDefaults.standard.object(forKey: Self.key) as? Bool ?? true
        usesCoreHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    }

    /// Warm the Taptic Engine (call when a screen that fires haptics appears).
    public func prepare() {
        guard enabled else { return }
        [light, medium, soft, rigid, heavy].forEach { $0.prepare() }
        selection.prepare()
        notification.prepare()
    }

    public func play(_ event: HapticEvent) {
        guard enabled else { return }
        // Rate limit: stops double fires and drag spam.
        let now = Date()
        if let last = lastFired[event], now.timeIntervalSince(last) < 0.04 { return }
        lastFired[event] = now
        switch event {
        case .tap: light.impactOccurred(intensity: 0.7)
        case .toggle: medium.impactOccurred(intensity: 0.7)
        case .select: selection.selectionChanged()
        case .tick: rigid.impactOccurred(intensity: 0.4)
        case .success: notification.notificationOccurred(.success)
        case .warning: notification.notificationOccurred(.warning)
        case .error: notification.notificationOccurred(.error)
        case .sheetOpen: soft.impactOccurred(intensity: 0.7)
        case .sheetDismiss: soft.impactOccurred(intensity: 0.4)
        case .holdCancel: light.impactOccurred(intensity: 0.3)
        case .send: playSendPop()
        }
    }

    // MARK: Hold to send

    /// Starts the build-up: intensity ramps over `ramp.duration` (1.5 s).
    public func beginHold(ramp: HoldRamp = HoldRamp()) {
        stopHoldPlayback()
        guard enabled else { return }
        holdStartedAt = Date()
        if let engine = ensureEngine(), startCoreHapticsRamp(engine, ramp) { return }
        startFallbackRamp(ramp)
    }

    /// Ends the hold. `completed` plays the pop (the message is being sent); otherwise a faint release tick.
    public func endHold(completed: Bool) {
        stopHoldPlayback()
        if completed { play(.send) } else if holdStartedAt != nil { play(.holdCancel) }
        holdStartedAt = nil
    }

    private func startCoreHapticsRamp(_ engine: CHHapticEngine, _ ramp: HoldRamp) -> Bool {
        do {
            try engine.start()
            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                             CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5)],
                relativeTime: 0, duration: ramp.duration)
            // The curve scales the event intensity over time: the buzz builds from faint to full strength.
            let intensityCurve = CHHapticParameterCurve(
                parameterID: .hapticIntensityControl,
                controlPoints: ramp.controlPoints().map {
                    CHHapticParameterCurve.ControlPoint(relativeTime: $0.time, value: Float($0.value))
                },
                relativeTime: 0)
            let sharpnessCurve = CHHapticParameterCurve(
                parameterID: .hapticSharpnessControl,
                controlPoints: [CHHapticParameterCurve.ControlPoint(relativeTime: 0, value: 0.3),
                                CHHapticParameterCurve.ControlPoint(relativeTime: ramp.duration, value: 1.0)],
                relativeTime: 0)
            let pattern = try CHHapticPattern(events: [event], parameterCurves: [intensityCurve, sharpnessCurve])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            holdPlayer = player
            return true
        } catch {
            return false
        }
    }

    private func startFallbackRamp(_ ramp: HoldRamp) {
        let start = Date()
        fallbackTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let t = Date().timeIntervalSince(start)
            if t > ramp.duration { timer.invalidate(); return }
            self.rigid.impactOccurred(intensity: CGFloat(ramp.intensity(at: t)))
        }
    }

    private func stopHoldPlayback() {
        fallbackTimer?.invalidate()
        fallbackTimer = nil
        try? holdPlayer?.stop(atTime: CHHapticTimeImmediate)
        holdPlayer = nil
    }

    private func playSendPop() {
        if let engine = ensureEngine() {
            do {
                try engine.start()
                let pop = CHHapticEvent(eventType: .hapticTransient,
                                        parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                                                     CHHapticEventParameter(parameterID: .hapticSharpness, value: 1.0)],
                                        relativeTime: 0)
                let echo = CHHapticEvent(eventType: .hapticTransient,
                                         parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.6),
                                                      CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.3)],
                                         relativeTime: 0.08)
                let player = try engine.makePlayer(with: try CHHapticPattern(events: [pop, echo], parameters: []))
                try player.start(atTime: CHHapticTimeImmediate)
                return
            } catch { /* fall through to UIKit */ }
        }
        heavy.impactOccurred(intensity: 1.0)
        notification.notificationOccurred(.success)
    }

    private func ensureEngine() -> CHHapticEngine? {
        guard usesCoreHaptics else { return nil }
        if let engine { return engine }
        do {
            let e = try CHHapticEngine()
            e.isAutoShutdownEnabled = true
            e.stoppedHandler = { [weak self] _ in DispatchQueue.main.async { self?.engine = nil } }
            e.resetHandler = { [weak self] in DispatchQueue.main.async { try? self?.engine?.start() } }
            try e.start()
            engine = e
            return e
        } catch {
            return nil
        }
    }
}
#endif
