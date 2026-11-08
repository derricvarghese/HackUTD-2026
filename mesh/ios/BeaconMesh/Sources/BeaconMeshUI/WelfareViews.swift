#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

/// Home card for an open welfare check-in. Overdue check-ins stay here (one card, no pile) until answered.
struct WelfareCard: View {
    let checkin: WelfareCheckin
    let action: () -> Void

    var body: some View {
        let overdue = checkin.isOverdue(Int64(Date().timeIntervalSince1970 * 1000))
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: overdue ? "exclamationmark.bubble.fill" : "bell.badge.fill").font(.title2)
                    .foregroundStyle(overdue ? .red : .orange).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(overdue ? WelfareNotificationModel.overdueTitle : "Responders are checking on you").font(.headline)
                    Text(overdue ? WelfareNotificationModel.overdueBody : (checkin.message ?? WelfareNotificationModel.defaultBody))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(12)
            .background((overdue ? Color.red : Color.orange).opacity(0.15), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the answer options")
    }
}

/// The in-app confirmation for a welfare check-in: three large buttons. Shown when the person taps the notification.
struct WelfareSheet: View {
    @ObservedObject var node: MeshNode
    let checkin: WelfareCheckin
    @ObservedObject private var haptics = Haptics.shared
    @Environment(\.dismiss) private var dismiss
    @State private var sending = false
    @State private var confirmation: String?

    private func deadlineText() -> String {
        Date(timeIntervalSince1970: Double(checkin.deadlineAtMs) / 1000).formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        let overdue = checkin.isOverdue(Int64(Date().timeIntervalSince1970 * 1000))
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(overdue ? WelfareNotificationModel.overdueBody : (checkin.message ?? WelfareNotificationModel.defaultBody))
                        .font(.title3.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    if !overdue {
                        Text("Please answer by \(deadlineText()).").font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let confirmation {
                        Label(confirmation, systemImage: "checkmark.circle.fill")
                            .font(.headline).foregroundStyle(.green)
                            .accessibilityAddTraits(.updatesFrequently)
                        Button("Done") { haptics.play(.sheetDismiss); dismiss() }
                            .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        ForEach(checkin.choices, id: \.self) { choice in answerButton(choice) }
                            .disabled(sending)
                    }
                    Text("This is only asked while you have an open SOS. Beacon tells responders your phone is on by itself; you never need to press anything for that.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .navigationTitle("Check-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Later") { haptics.play(.sheetDismiss); dismiss() } }
            }
        }
        .onAppear { haptics.prepare() }
    }

    private func answerButton(_ choice: String) -> some View {
        let urgent = choice == WelfareResponse.needUrgentHelp
        return Button {
            haptics.play(urgent ? .warning : .tap)
            sending = true
            Task {
                _ = await node.answerCheckin(id: checkin.checkinId, response: choice)
                await MainActor.run {
                    sending = false
                    haptics.play(.success)
                    confirmation = WelfareResponse.confirmation(choice)
                }
            }
        } label: {
            Label(WelfareResponse.label(choice), systemImage: Self.symbol(choice))
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 64)
        }
        .buttonStyle(.borderedProminent)
        .tint(urgent ? .red : choice == WelfareResponse.noLongerNeedHelp ? .blue : .green)
        .accessibilityLabel(WelfareResponse.label(choice))
        .accessibilityHint(urgent ? "Tells responders you need urgent help" : choice == WelfareResponse.noLongerNeedHelp ? "Closes your request for help" : "Tells responders you are still there")
    }

    private static func symbol(_ choice: String) -> String {
        switch choice {
        case WelfareResponse.needUrgentHelp: return "exclamationmark.triangle.fill"
        case WelfareResponse.noLongerNeedHelp: return "checkmark.shield.fill"
        default: return "hand.raised.fill"
        }
    }
}
#endif
