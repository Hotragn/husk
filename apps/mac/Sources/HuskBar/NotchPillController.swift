import AppKit
import HuskBarCore
import SwiftUI

/// The pill under the notch: hidden when nothing runs, "1 computer" while one
/// runs, amber "Waiting for you" on a handoff. Hover expands it into the list.
/// Only on a display that has a notch; elsewhere the menu-bar icon does the job.
final class NotchPillController {
    private let panel: NSPanel
    private let model = PillModel()
    private let collapsed = CGSize(width: 220, height: 30)
    private let expandedHeight: CGFloat = 220

    init(open: @escaping () -> Void, takeOver: @escaping () -> Void) {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isMovable = false
        model.open = open
        model.takeOver = takeOver
        model.onExpand = { [weak self] _ in self?.place() }
        panel.contentView = NSHostingView(rootView: PillView(model: model))
    }

    func update(summary: Summary, overview: Overview?) {
        model.summary = summary
        model.overview = overview
        place()
    }

    /// Re-find the notch each time: the built-in display may not be the main
    /// one, and an external display has none.
    private func place() {
        guard model.summary.pillText != nil, let notch = currentNotch() else {
            panel.orderOut(nil)
            return
        }
        let height = model.expanded ? expandedHeight : collapsed.height
        panel.setFrame(pillFrame(notch: notch, width: collapsed.width, height: height), display: true)
        panel.orderFrontRegardless()
    }

    private func currentNotch() -> CGRect? {
        for screen in NSScreen.screens {
            if let rect = notchRect(screenFrame: screen.frame,
                                    safeAreaTop: screen.safeAreaInsets.top,
                                    topLeftArea: screen.auxiliaryTopLeftArea,
                                    topRightArea: screen.auxiliaryTopRightArea) {
                return rect
            }
        }
        return nil
    }
}

final class PillModel: ObservableObject {
    @Published var summary: Summary = .disconnected
    @Published var overview: Overview?
    @Published var expanded = false { didSet { onExpand?(expanded) } }
    var open: () -> Void = {}
    var takeOver: () -> Void = {}
    var onExpand: ((Bool) -> Void)?
}

struct PillView: View {
    @ObservedObject var model: PillModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(model.summary.isWaiting ? Color.orange : Color.green).frame(width: 8, height: 8)
                Text(model.summary.pillText ?? "").font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 0)
            }
            if model.expanded, let overview = model.overview {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(overview.computers) { computer in
                            row(computer, waiting: overview.handoffs.first { $0.computerId == computer.id })
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundColor(.white)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.black))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(model.summary.isWaiting ? Color.orange : Color.clear, lineWidth: 1))
        .onHover { model.expanded = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.summary.pillText ?? "Husk")
    }

    private func row(_ computer: Computer, waiting: Handoff?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(computer.title).font(.system(size: 11, weight: .medium)).lineLimit(1)
            if let waiting {
                Text(waiting.reason).font(.system(size: 10)).foregroundColor(.orange).lineLimit(2)
                Button("Take over", action: model.takeOver).buttonStyle(.borderless).font(.system(size: 10))
            } else {
                HStack {
                    Text([computer.platform, computer.state].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 10)).foregroundColor(.gray)
                    Button("Open", action: model.open).buttonStyle(.borderless).font(.system(size: 10))
                }
            }
        }
    }
}
