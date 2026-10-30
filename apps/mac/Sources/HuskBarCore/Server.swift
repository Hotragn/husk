import Foundation

/// The shared Husk's record, which it writes as it starts: its address and
/// token. The desktop app and a chat's MCP server find it the same way. Read
/// again on every poll, since a Husk that restarted has a new token.
public struct DaemonRecord: Decodable, Equatable {
    public let url: String
    public let token: String?
}

/// Where the record is: `$HUSK_HOME/daemon.json`, else `~/.husk/daemon.json`.
public func daemonRecordURL(environment: [String: String], home: URL) -> URL {
    let root = environment["HUSK_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
        ?? home.appendingPathComponent(".husk", isDirectory: true)
    return root.appendingPathComponent("daemon.json")
}

/// The record, or nil when there is none or it cannot be read.
public func readDaemonRecord(at url: URL) -> DaemonRecord? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(DaemonRecord.self, from: data)
}

/// Where the local Husk server is. Set by hand, `HUSK_URL` and `HUSK_TOKEN`
/// win, read as the CLI and SDK read them; else the shared Husk's record;
/// else http://127.0.0.1:7377. The app stores nothing of its own and never
/// asks for credentials.
public struct ServerConfig: Equatable {
    public let baseURL: URL
    public let token: String?

    /// Loopback only. Anything else is refused, not contacted.
    public init?(environment: [String: String], record: DaemonRecord? = nil) {
        func set(_ name: String) -> String? { environment[name].flatMap { $0.isEmpty ? nil : $0 } }
        let shared = set("HUSK_URL") == nil && set("HUSK_TOKEN") == nil ? record : nil
        let raw = shared?.url ?? set("HUSK_URL") ?? "http://127.0.0.1:7377"
        guard let url = URL(string: raw), ServerConfig.isLoopback(url) else { return nil }
        baseURL = url
        let token = shared != nil ? shared?.token : set("HUSK_TOKEN")
        self.token = (token ?? "").isEmpty ? nil : token
    }

    public static func isLoopback(_ url: URL) -> Bool {
        guard url.scheme == "http" || url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }

    public var overviewURL: URL { baseURL.appendingPathComponent("v1/overview") }

    /// The console's Home. No token in the URL: a URL lands in browser history.
    public var consoleURL: URL { page("home") }

    /// The console's Handoffs panel, where the person takes over.
    public var takeOverURL: URL { page("handoffs") }

    private func page(_ panel: String) -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/#/\(panel)")!
    }

    public func request() -> URLRequest {
        var req = URLRequest(url: overviewURL, timeoutInterval: 5)
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }
}

/// The Husk desktop app's bundle id. While it runs, its own notch shows the
/// computers, so Husk Bar's pill makes way: one notch, not two.
public let desktopAppBundleID = "dev.husk.desktop"

/// Whether Husk Bar shows its pill: something to say, and no desktop app saying it.
public func showsPill(_ summary: Summary, desktopAppRunning: Bool) -> Bool {
    summary.pillText != nil && !desktopAppRunning
}

/// Decode an overview body. Nil on anything unexpected, so the app shows
/// "not connected" rather than stale or half-read state.
public func decodeOverview(_ data: Data) -> Overview? {
    try? JSONDecoder().decode(Overview.self, from: data)
}
