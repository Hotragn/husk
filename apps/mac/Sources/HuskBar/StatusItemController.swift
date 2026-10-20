import AppKit
import HuskBarCore

/// The menu-bar icon, on every Mac, and its menu of computers.
final class StatusItemController: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let open: () -> Void
    private let takeOver: () -> Void
    private let quit: () -> Void

    init(open: @escaping () -> Void, takeOver: @escaping () -> Void, quit: @escaping () -> Void) {
        self.open = open
        self.takeOver = takeOver
        self.quit = quit
        super.init()
        item.button?.toolTip = "Husk"
    }

    func update(summary: Summary, overview: Overview?, problem: String?) {
        let symbol = summary.isWaiting ? "exclamationmark.circle.fill" : "desktopcomputer"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: summary.pillText ?? "Husk")
        image?.isTemplate = !summary.isWaiting
        item.button?.image = image
        item.button?.contentTintColor = summary.isWaiting ? .systemOrange : nil
        item.button?.title = summary.pillText.map { " \($0)" } ?? ""
        item.button?.imagePosition = .imageLeading
        item.menu = menu(overview: overview, problem: problem)
    }

    private func menu(overview: Overview?, problem: String?) -> NSMenu {
        let menu = NSMenu()
        if let problem {
            menu.addItem(disabled(problem))
        } else if let overview, !overview.computers.isEmpty {
            for computer in overview.computers {
                let waiting = overview.handoffs.first { $0.computerId == computer.id }
                let line = [computer.title, computer.platform, waiting == nil ? computer.state : "waiting for you"]
                    .compactMap { $0 }
                    .joined(separator: " · ")
                let entry = NSMenuItem(title: line, action: nil, keyEquivalent: "")
                let sub = NSMenu()
                if let waiting {
                    sub.addItem(disabled(waiting.reason))
                    sub.addItem(action("Take over", #selector(doTakeOver)))
                }
                sub.addItem(action("Open", #selector(doOpen)))
                entry.submenu = sub
                menu.addItem(entry)
            }
        } else {
            menu.addItem(disabled("No computers yet"))
        }
        menu.addItem(.separator())
        menu.addItem(action("Open Husk console", #selector(doOpen)))
        menu.addItem(action("Quit Husk Bar", #selector(doQuit), key: "q"))
        return menu
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func doOpen() { open() }
    @objc private func doTakeOver() { takeOver() }
    @objc private func doQuit() { quit() }
}
