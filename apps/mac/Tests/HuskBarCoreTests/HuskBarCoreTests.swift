import CoreGraphics
import XCTest
@testable import HuskBarCore

final class SummaryTests: XCTestCase {
    private func overview(running: Int, waiting: Int) -> Overview {
        let computers = (0..<running).map { Computer(id: "cmp_\($0)", state: "running", provider: "docker") }
        let handoffs = (0..<waiting).map { Handoff(handoffId: "hnd_\($0)", reason: "Sign in.", computerId: "cmp_\($0)") }
        return Overview(computers: computers, activeRuns: [], handoffs: handoffs)
    }

    func testPillTextFollowsState() {
        XCTAssertNil(Summary(nil).pillText)
        XCTAssertNil(Summary(overview(running: 0, waiting: 0)).pillText)
        XCTAssertEqual(Summary(overview(running: 1, waiting: 0)).pillText, "1 computer")
        XCTAssertEqual(Summary(overview(running: 3, waiting: 0)).pillText, "3 computers")
        XCTAssertEqual(Summary(overview(running: 2, waiting: 1)).pillText, "Waiting for you")
        XCTAssertTrue(Summary(overview(running: 2, waiting: 1)).isWaiting)
    }

    func testAComputerThePersonTookIsNotWaitingOnThem() {
        let taken = Handoff(handoffId: "hnd_me", reason: "You took over this computer", computerId: "cmp_0", runId: "person")
        let o = Overview(computers: [Computer(id: "cmp_0", state: "running", provider: "docker")], activeRuns: [], handoffs: [taken])
        XCTAssertEqual(Summary(o), .running(1))
    }

    func testStoppedComputersDoNotShowThePill() {
        let o = Overview(computers: [Computer(id: "cmp_1", state: "stopped", provider: "local")], activeRuns: [], handoffs: [])
        XCTAssertEqual(Summary(o), .idle)
    }
}

final class ServerConfigTests: XCTestCase {
    func testDefaultsToTheLocalServer() {
        let c = ServerConfig(environment: [:])
        XCTAssertEqual(c?.baseURL.absoluteString, "http://127.0.0.1:7377")
        XCTAssertNil(c?.token)
        XCTAssertNil(c?.request().value(forHTTPHeaderField: "Authorization"))
    }

    func testSendsTheTokenTheCLIUses() {
        let c = ServerConfig(environment: ["HUSK_TOKEN": "abc"])
        XCTAssertEqual(c?.request().value(forHTTPHeaderField: "Authorization"), "Bearer abc")
    }

    func testRefusesAnythingButLoopback() {
        XCTAssertNil(ServerConfig(environment: ["HUSK_URL": "http://evil.example:7377"]))
        XCTAssertNil(ServerConfig(environment: ["HUSK_URL": "http://192.168.1.5:7377"]))
        XCTAssertNotNil(ServerConfig(environment: ["HUSK_URL": "http://localhost:9000"]))
    }

    func testConsoleLinksCarryNoToken() {
        let c = ServerConfig(environment: ["HUSK_TOKEN": "abc"])!
        XCTAssertEqual(c.consoleURL.absoluteString, "http://127.0.0.1:7377/#/home")
        XCTAssertFalse(c.takeOverURL.absoluteString.contains("abc"))
    }

    func testDecodesAnOverviewAndRejectsGarbage() {
        let json = """
        {"computers":[{"id":"cmp_1","state":"running","provider":"docker","platform":"Cursor","chatLabel":"Cursor · chat started 09:12","extra":1}],
         "activeRuns":[{"runId":"run_1","husk":"triage","computerId":"cmp_1","step":2,"tool":"shell"}],
         "handoffs":[{"handoffId":"hnd_1","reason":"Sign in.","computerId":"cmp_1","createdAt":"x"}]}
        """
        let o = decodeOverview(Data(json.utf8))
        XCTAssertEqual(o?.computers.first?.title, "Cursor · chat started 09:12")
        XCTAssertEqual(o?.handoffs.count, 1)
        XCTAssertNil(decodeOverview(Data("not json".utf8)))
    }
}

final class SharedHuskTests: XCTestCase {
    private let record = DaemonRecord(url: "http://127.0.0.1:52411", token: "t0ken")

    func testFindsTheSharedHuskFromItsRecord() {
        let c = ServerConfig(environment: [:], record: record)
        XCTAssertEqual(c?.baseURL.absoluteString, "http://127.0.0.1:52411")
        XCTAssertEqual(c?.request().value(forHTTPHeaderField: "Authorization"), "Bearer t0ken")
        XCTAssertNil(ServerConfig(environment: [:], record: DaemonRecord(url: "http://127.0.0.1:52411", token: nil))?.token)
    }

    func testTheEnvironmentWinsWhenSetByHand() {
        let both = ServerConfig(environment: ["HUSK_URL": "http://localhost:9000", "HUSK_TOKEN": "mine"], record: record)
        XCTAssertEqual(both?.baseURL.absoluteString, "http://localhost:9000")
        XCTAssertEqual(both?.token, "mine")
        let tokenOnly = ServerConfig(environment: ["HUSK_TOKEN": "mine"], record: record)
        XCTAssertEqual(tokenOnly?.baseURL.absoluteString, "http://127.0.0.1:7377")
        XCTAssertEqual(tokenOnly?.token, "mine")
    }

    func testRefusesARecordThatIsNotLoopback() {
        XCTAssertNil(ServerConfig(environment: [:], record: DaemonRecord(url: "http://10.0.0.2:7377", token: nil)))
    }

    func testReadsTheRecordWhereHuskWritesIt() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let file = daemonRecordURL(environment: [:], home: home)
        XCTAssertEqual(file.path, home.appendingPathComponent(".husk/daemon.json").path)
        XCTAssertEqual(daemonRecordURL(environment: ["HUSK_HOME": "/tmp/h"], home: home).path, "/tmp/h/daemon.json")
        XCTAssertNil(readDaemonRecord(at: file))
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"url":"http://127.0.0.1:52411","token":null,"pid":42,"version":"0.2.0","startedAt":"x"}"#.utf8).write(to: file)
        XCTAssertEqual(readDaemonRecord(at: file), DaemonRecord(url: "http://127.0.0.1:52411", token: nil))
    }

    func testThePillMakesWayForTheDesktopApp() {
        XCTAssertTrue(showsPill(.running(1), desktopAppRunning: false))
        XCTAssertFalse(showsPill(.running(1), desktopAppRunning: true))
        XCTAssertFalse(showsPill(.waiting(1), desktopAppRunning: true))
        XCTAssertFalse(showsPill(.idle, desktopAppRunning: false))
    }
}

final class NotchGeometryTests: XCTestCase {
    // A 14-inch MacBook Pro's built-in display, in points.
    private let frame = CGRect(x: 0, y: 0, width: 1512, height: 982)

    func testFindsTheNotchBetweenTheTwoMenuBarAreas() {
        let left = CGRect(x: 0, y: 950, width: 661, height: 32)
        let right = CGRect(x: 851, y: 950, width: 661, height: 32)
        let notch = notchRect(screenFrame: frame, safeAreaTop: 32, topLeftArea: left, topRightArea: right)
        XCTAssertEqual(notch, CGRect(x: 661, y: 950, width: 190, height: 32))
    }

    func testNoNotchOnAnExternalDisplay() {
        XCTAssertNil(notchRect(screenFrame: frame, safeAreaTop: 0, topLeftArea: nil, topRightArea: nil))
        XCTAssertNil(notchRect(screenFrame: frame, safeAreaTop: 32, topLeftArea: nil, topRightArea: nil))
    }

    func testThePillSitsCentredUnderTheNotch() {
        let notch = CGRect(x: 661, y: 950, width: 190, height: 32)
        let pill = pillFrame(notch: notch, width: 220, height: 30)
        XCTAssertEqual(pill.midX, notch.midX)
        XCTAssertEqual(pill.maxY, notch.minY)
        XCTAssertEqual(pill.width, 220)
    }
}

final class PlacementTests: XCTestCase {
    private let builtIn = ScreenGeometry(frame: CGRect(x: 0, y: 0, width: 1512, height: 982), safeAreaTop: 32,
                                         topLeftArea: CGRect(x: 0, y: 950, width: 661, height: 32),
                                         topRightArea: CGRect(x: 851, y: 950, width: 661, height: 32))
    private let external = ScreenGeometry(frame: CGRect(x: 1512, y: 0, width: 2560, height: 1440), safeAreaTop: 0,
                                          topLeftArea: nil, topRightArea: nil)

    func testUsesTheNotchOnTheBuiltInDisplay() {
        XCTAssertEqual(pillPlacement(screens: [builtIn]), .notch(CGRect(x: 661, y: 950, width: 190, height: 32)))
    }

    func testFindsTheNotchEvenWhenAnExternalDisplayIsMain() {
        XCTAssertEqual(pillPlacement(screens: [external, builtIn]), .notch(CGRect(x: 661, y: 950, width: 190, height: 32)))
    }

    func testFallsBackToTheMenuBarWithNoNotch() {
        XCTAssertEqual(pillPlacement(screens: [external]), .menuBarOnly)
        XCTAssertEqual(pillPlacement(screens: []), .menuBarOnly)
    }
}

final class ComputerStatusTests: XCTestCase {
    func testWaitingWinsOverTheMachineState() {
        let c = Computer(id: "cmp_1", state: "running", provider: "docker")
        let o = Overview(computers: [c], activeRuns: [], handoffs: [Handoff(handoffId: "hnd_1", reason: "Sign in.", computerId: "cmp_1")])
        XCTAssertEqual(status(of: c, in: o), .waiting(reason: "Sign in."))
        XCTAssertEqual(status(of: c, in: o).label, "waiting for you")
    }

    func testReportsRunningStoppedAndOtherStates() {
        let empty = Overview(computers: [], activeRuns: [], handoffs: [])
        XCTAssertEqual(status(of: Computer(id: "a", state: "running", provider: "docker"), in: empty), .running)
        XCTAssertEqual(status(of: Computer(id: "b", state: "stopped", provider: "local"), in: empty), .stopped)
        XCTAssertEqual(status(of: Computer(id: "c", state: "error", provider: "docker"), in: empty), .other("error"))
    }

    func testAHandoffForAnotherComputerDoesNotMarkThisOne() {
        let c = Computer(id: "cmp_1", state: "running", provider: "docker")
        let o = Overview(computers: [c], activeRuns: [], handoffs: [Handoff(handoffId: "hnd_1", reason: "Sign in.", computerId: "cmp_2")])
        XCTAssertEqual(status(of: c, in: o), .running)
    }
}

final class TokenLoadingTests: XCTestCase {
    func testAnEmptyTokenIsNoToken() {
        XCTAssertNil(ServerConfig(environment: ["HUSK_TOKEN": ""])?.token)
    }

    func testAnEmptyURLFallsBackToTheDefault() {
        XCTAssertEqual(ServerConfig(environment: ["HUSK_URL": ""])?.baseURL.absoluteString, "http://127.0.0.1:7377")
    }

    func testRefusesANonHTTPScheme() {
        XCTAssertNil(ServerConfig(environment: ["HUSK_URL": "file:///etc/passwd"]))
        XCTAssertNil(ServerConfig(environment: ["HUSK_URL": "ftp://127.0.0.1:7377"]))
    }
}
