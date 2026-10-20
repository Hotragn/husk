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
