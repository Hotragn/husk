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
        config = ServerConfig(environment: ProcessInfo.processInfo.environment)
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
    }

    private func poll() {
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
            case nil: "Husk is not running. Start it with `husk serve`."
            case 401?: "Husk asks for a token. Launch Husk Bar with the same HUSK_TOKEN as the server."
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
        let why = config == nil ? "HUSK_URL is not a loopback address, so Husk Bar will not contact it." : problem
        status?.update(summary: summary, overview: overview, problem: why)
        pill?.update(summary: summary, overview: overview)
    }

    private func open(_ url: KeyPath<ServerConfig, URL>) {
        guard let config else { return }
        NSWorkspace.shared.open(config[keyPath: url])
    }
}
