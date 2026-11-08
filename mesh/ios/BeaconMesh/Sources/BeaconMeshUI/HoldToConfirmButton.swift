#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI

/// A button that must be held for `holdDuration` to fire. A progress fill and a haptic ramp build up while held and a pop
/// plays on send. VoiceOver users get a "Send now" action instead, since holding is hard with assistive touch.
struct HoldToConfirmButton: View {
    let title: String
    var systemImage: String = "paperplane.fill"
    var tint: Color = .red
    var holdDuration: Double = 1.5
    let onConfirm: () -> Void

    @ObservedObject private var haptics = Haptics.shared
    @State private var progress: CGFloat = 0
    @State private var confirmed = false
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 56

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(tint.opacity(0.18))
            GeometryReader { geo in
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(tint)
                    .frame(width: max(0, geo.size.width * progress))
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                Text(progress > 0 ? "Keep holding…" : "Hold to send: \(title)")
                    .multilineTextAlignment(.center)
            }
            .font(.headline)
            .foregroundStyle(progress > 0.45 ? Color.white : tint)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
        }
        .frame(minHeight: minHeight)
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onLongPressGesture(minimumDuration: holdDuration, maximumDistance: 80, pressing: { pressing in
            if pressing {
                confirmed = false
                haptics.beginHold()
                withAnimation(.linear(duration: holdDuration)) { progress = 1 }
            } else if confirmed {
                confirmed = false
            } else {
                haptics.endHold(completed: false)
                withAnimation(.easeOut(duration: 0.2)) { progress = 0 }
            }
        }, perform: {
            confirmed = true
            haptics.endHold(completed: true)
            progress = 0
            onConfirm()
        })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Hold to send \(title)")
        .accessibilityHint("Press and hold for \(String(format: "%.1f", holdDuration)) seconds to send.")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Send now") {
            haptics.play(.send)
            onConfirm()
        }
    }
}
#endif
