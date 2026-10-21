import Foundation

/// `GET /v1/overview` from the local Husk server. Only the fields the app shows.
public struct Overview: Decodable, Equatable {
    public var computers: [Computer]
    public var activeRuns: [ActiveRun]
    public var handoffs: [Handoff]

    public init(computers: [Computer], activeRuns: [ActiveRun], handoffs: [Handoff]) {
        self.computers = computers
        self.activeRuns = activeRuns
        self.handoffs = handoffs
    }
}

public struct Computer: Decodable, Equatable, Identifiable {
    public var id: String
    public var name: String?
    public var state: String
    public var provider: String
    public var platform: String?
    public var chatLabel: String?

    public init(id: String, name: String? = nil, state: String, provider: String, platform: String? = nil, chatLabel: String? = nil) {
        self.id = id
        self.name = name
        self.state = state
        self.provider = provider
        self.platform = platform
        self.chatLabel = chatLabel
    }

    /// What a person calls it: the chat label, else its name, else its id.
    public var title: String { chatLabel ?? name ?? id }
}

public struct ActiveRun: Decodable, Equatable {
    public var runId: String
    public var husk: String
    public var computerId: String?
    public var step: Int?
    public var tool: String?
}

public struct Handoff: Decodable, Equatable {
    public var handoffId: String
    public var reason: String
    public var computerId: String?

    public init(handoffId: String, reason: String, computerId: String? = nil) {
        self.handoffId = handoffId
        self.reason = reason
        self.computerId = computerId
    }
}

/// What the pill and the menu-bar icon show.
public enum Summary: Equatable {
    /// Nothing running and nothing waiting: the pill hides.
    case idle
    case running(Int)
    case waiting(Int)
    /// The server did not answer.
    case disconnected

    public init(_ overview: Overview?) {
        guard let overview else {
            self = .disconnected
            return
        }
        if !overview.handoffs.isEmpty {
            self = .waiting(overview.handoffs.count)
            return
        }
        let running = overview.computers.filter { $0.state == "running" }.count
        self = running == 0 ? .idle : .running(running)
    }

    /// The pill's text, or nil when it should be hidden.
    public var pillText: String? {
        switch self {
        case .idle, .disconnected: return nil
        case .running(1): return "1 computer"
        case let .running(n): return "\(n) computers"
        case .waiting: return "Waiting for you"
        }
    }

    public var isWaiting: Bool {
        if case .waiting = self { return true }
        return false
    }
}
