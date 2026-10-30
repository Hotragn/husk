import AppKit
import HuskBarCore

/// Polls the local Husk server and keeps the menu-bar icon and the notch pill in step.
///
/// It talks only to the loopback server, over plain HTTP, every three seconds.
/// No Full Disk Access, Accessibility or screen-recording permission is needed
/// or requested: it reads JSON from localhost and opens URLs in the browser.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var config: ServerConfig?
    private var status: StatusItemController?
    private var pill: NotchPillController?
    private var timer: Timer?
    private(set) var overview: Overview?
    /// Why there is no overview, in words for the menu. Nil when connected.
    private var problem: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        config = Self.findHusk()
        status = StatusItemController(open: { [weak self] in self?.open(\.consoleURL) },
                                      takeOver: { [weak self] in self?.open(\.takeOverURL) },
                                      quit: { NSApp.terminate(nil) })
        pill = NotchPillController(open: { [weak self] in self?.open(\.consoleURL) },
                                   takeOver: { [weak self] in self?.open(\.takeOverURL) })
        render()
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
        // Displays come and go; the notch is re-found on every change.
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in self?.render() }
        // The desktop app shows its own notch: the pill makes way while it runs.
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.render() }
        }
    }

    /// The shared Husk's address and token, from its record, unless HUSK_URL or HUSK_TOKEN say otherwise.
    private static func findHusk() -> ServerConfig? {
        let environment = ProcessInfo.processInfo.environment
        let file = daemonRecordURL(environment: environment, home: FileManager.default.homeDirectoryForCurrentUser)
        return ServerConfig(environment: environment, record: readDaemonRecord(at: file))
    }

    private func poll() {
        // Every time: a Husk that restarted has a new token, and maybe a new port.
        config = Self.findHusk()
        guard let config else {
            overview = nil
            render()
            return
        }
        URLSession.shared.dataTask(with: config.request()) { [weak self] data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode
            let next = code == 200 ? data.flatMap(decodeOverview) : nil
            let problem: String? = switch code {
            case 200? where next != nil: nil
            case 200?: "Husk sent something Husk Bar cannot read. Update both."
            case nil: "Husk is not running. A chat that uses it starts it, and so does the Husk app."
            case 401?: "Husk refused Husk Bar. If you run the server yourself, launch Husk Bar with its HUSK_TOKEN."
            case 404?: "This Husk is too old for Husk Bar. Update it."
            default: "Husk answered with an error (\(code ?? 0))."
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if next != self.overview || problem != self.problem {
                    self.overview = next
                    self.problem = problem
                    self.render()
                }
            }
        }.resume()
    }

    private func render() {
        let summary = Summary(overview)
        let why = config == nil ? "Husk's address is not a loopback address, so Husk Bar will not contact it." : problem
        status?.update(summary: summary, overview: overview, problem: why)
        pill?.update(summary: summary, overview: overview)
    }

    private func open(_ url: KeyPath<ServerConfig, URL>) {
        guard let config else { return }
        NSWorkspace.shared.open(config[keyPath: url])
    }
}
