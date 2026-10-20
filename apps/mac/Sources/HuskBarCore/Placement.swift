import CoreGraphics

/// What `NSScreen` reports about one display, without AppKit, so the choice
/// below can be tested on any machine.
public struct ScreenGeometry: Equatable {
    public var frame: CGRect
    public var safeAreaTop: CGFloat
    public var topLeftArea: CGRect?
    public var topRightArea: CGRect?

    public init(frame: CGRect, safeAreaTop: CGFloat, topLeftArea: CGRect?, topRightArea: CGRect?) {
        self.frame = frame
        self.safeAreaTop = safeAreaTop
        self.topLeftArea = topLeftArea
        self.topRightArea = topRightArea
    }
}

/// Where the app shows itself: a pill under a notch, or the menu bar alone.
public enum PillPlacement: Equatable {
    case notch(CGRect)
    case menuBarOnly
}

/// The first display with a notch gets the pill; with none (external displays,
/// Macs without a notch, a closed lid) the menu-bar icon is all there is.
public func pillPlacement(screens: [ScreenGeometry]) -> PillPlacement {
    for s in screens {
        if let rect = notchRect(screenFrame: s.frame, safeAreaTop: s.safeAreaTop, topLeftArea: s.topLeftArea, topRightArea: s.topRightArea) {
            return .notch(rect)
        }
    }
    return .menuBarOnly
}

/// One computer as the menu and the pill describe it.
public enum ComputerStatus: Equatable {
    case waiting(reason: String)
    case running
    case stopped
    case other(String)

    public var label: String {
        switch self {
        case .waiting: return "waiting for you"
        case .running: return "running"
        case .stopped: return "stopped"
        case let .other(state): return state
        }
    }
}

/// Waiting wins over the machine's own state: a person is needed.
public func status(of computer: Computer, in overview: Overview) -> ComputerStatus {
    if let handoff = overview.handoffs.first(where: { $0.computerId == computer.id }) {
        return .waiting(reason: handoff.reason)
    }
    switch computer.state {
    case "running": return .running
    case "stopped": return .stopped
    default: return .other(computer.state)
    }
}
