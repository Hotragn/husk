import Foundation

/// Where the local Husk server is, read from the same place the CLI and SDK
/// read it: `HUSK_URL` (default http://127.0.0.1:7377) and `HUSK_TOKEN`.
/// The app stores nothing of its own and never asks for credentials.
public struct ServerConfig: Equatable {
    public let baseURL: URL
    public let token: String?

    /// Loopback only. Anything else is refused, not contacted.
    public init?(environment: [String: String]) {
        let raw = environment["HUSK_URL"].flatMap { $0.isEmpty ? nil : $0 } ?? "http://127.0.0.1:7377"
        guard let url = URL(string: raw), ServerConfig.isLoopback(url) else { return nil }
        baseURL = url
        let token = environment["HUSK_TOKEN"] ?? ""
        self.token = token.isEmpty ? nil : token
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

/// Decode an overview body. Nil on anything unexpected, so the app shows
/// "not connected" rather than stale or half-read state.
public func decodeOverview(_ data: Data) -> Overview? {
    try? JSONDecoder().decode(Overview.self, from: data)
}
