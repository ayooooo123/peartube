import XCTest

final class ParityTests: XCTestCase {
    var app: XCUIApplication!
    var fixture: [String: Any] = [:]

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let url = Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json") else {
            throw XCTSkip("Run node ios/e2e.mjs to provide a live relay fixture.")
        }
        fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        app = XCUIApplication()
        app.launchArguments = ["-peartube-e2e", "-peartube-storage", try XCTUnwrap(fixture["storage"] as? String), "-peartube-tracker", try XCTUnwrap(fixture["tracker"] as? String), "-peartube-bootstrap", try XCTUnwrap(fixture["bootstrap"] as? String), "-peartube-lan", fixture["lan"] as? Bool == true ? "true" : "false"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        try checkSystemPrompt()
    }

    override func tearDownWithError() throws {
        guard let app, app.state == .runningForeground, (testRun?.failureCount ?? 0) > 0 else { return }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if !springboard.alerts.firstMatch.exists && !app.alerts.firstMatch.exists && !element("cast.pairInput").exists {
            screenshot("failure-state")
        }
    }

    func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", id)).firstMatch }
    func tap(_ id: String, timeout: TimeInterval = 15) throws {
        try checkSystemPrompt()
        let target = element(id)
        let surface = element("player.surface")
        if id.hasPrefix("player."), id != "player.surface", !target.isHittable, !element("player.info.close").exists, surface.exists {
            surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
        }
        if !target.exists && !target.waitForExistence(timeout: timeout) {
            for _ in 0..<5 where !target.exists {
                try checkSystemPrompt()
                app.swipeUp()
            }
        }
        XCTAssertTrue(target.exists, "Missing \(id): \(app.debugDescription)")
        for _ in 0..<5 where !target.isHittable {
            if target.frame.midY > app.frame.midY { app.swipeUp() } else { app.swipeDown() }
        }
        XCTAssertTrue(target.isHittable, "Unreachable control \(id): \(app.debugDescription)")
        target.tap()
    }

    func checkSystemPrompt() throws {
        // Never answer system prompts. The user must grant permissions themselves.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.exists {
            throw NSError(domain: "PearTubeE2E", code: 1, userInfo: [NSLocalizedDescriptionKey: "A system prompt is in front. Ask the user to answer it, then rerun."])
        }
    }

    func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "peartube-evidence-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
    }

    func assertFullscreen(file: StaticString = #filePath, line: UInt = #line) throws {
        let surface = element("player.surface")
        XCTAssertTrue(surface.waitForExistence(timeout: 15), file: file, line: line)
        XCTAssertEqual(surface.frame.width, app.frame.width, accuracy: 4, file: file, line: line)
        XCTAssertEqual(surface.frame.height, app.frame.height, accuracy: 4, file: file, line: line)
    }

    private func revealControlsDuringPlayback() throws -> XCUICoordinate {
        let movie = try XCTUnwrap(fixture["movieKey"] as? String)
        let row = element("library.entry.\(movie)")
        XCTAssertTrue(row.waitForExistence(timeout: 150))
        row.tap()
        let surface = element("player.surface")
        XCTAssertTrue(surface.waitForExistence(timeout: 45))
        let pause = element("player.pause")
        XCTAssertTrue(pause.waitForNonExistence(timeout: 15), "Controls must first hide during playback")
        let video = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22))
        video.tap()
        XCTAssertTrue(pause.exists)
        XCTAssertEqual(pause.label, "Pause")
        return video
    }

    func testSecondVideoTapHidesControlsImmediately() throws {
        let video = try revealControlsDuringPlayback()
        let start = ContinuousClock.now
        video.tap()
        XCTAssertTrue(element("player.pause").waitForNonExistence(timeout: 1))
        XCTAssertLessThan(start.duration(to: .now), .seconds(1))
    }

    func testSeekButtonKeepsControlsVisible() throws {
        _ = try revealControlsDuringPlayback()
        element("player.skipForward").tap()
        XCTAssertTrue(element("player.skipBack").isHittable)
        XCTAssertTrue(element("player.clock").exists)
    }

    func testLibraryPlaybackAndLifecycle() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        let movie = try XCTUnwrap(fixture["movieKey"] as? String)
        let row = element("library.entry.\(movie)")
        XCTAssertTrue(row.waitForExistence(timeout: 150), "The on-device worklet did not synchronize the relay movie. \(app.debugDescription)")
        screenshot("library-synchronized")

        try tap("nav.watch")
        try tap("filters.series")
        XCTAssertFalse(row.exists, "A movie must not appear in the series filter")
        try tap("filters.movies")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        try tap("filters.all")

        try tap("nav.search")
        let search = element("search.field")
        search.tap(); search.typeText("no-such-peartube-entry")
        XCTAssertFalse(row.waitForExistence(timeout: 2))
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "no-such-peartube-entry".count))
        try tap("nav.watch")
        XCTAssertTrue(row.waitForExistence(timeout: 10))

        try tap("library.hood")
        XCTAssertTrue(element("hood.refresh").waitForExistence(timeout: 10))
        screenshot("under-the-hood")
        app.navigationBars.buttons["Done"].firstMatch.tap()
        try tap("library.entry.\(movie)")
        let surface = element("player.surface")
        XCTAssertTrue(surface.waitForExistence(timeout: 45), "Player did not open")
        try assertFullscreen()
        let initial = surface.value as? String
        let clockMoves = NSPredicate { _, _ in surface.exists && surface.value as? String != initial }
        expectation(for: clockMoves, evaluatedWith: nil)
        waitForExpectations(timeout: 40)
        screenshot("native-player-running")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element("player.clock"))
        waitForExpectations(timeout: 10)
        XCTAssertFalse(element("player.pause").exists, "The clock and playback controls must hide together")
        screenshot("player-controls-hidden")
        try tap("player.surface")
        XCTAssertTrue(element("player.clock").waitForExistence(timeout: 5), "Revealing controls must restore the playback time")
        screenshot("player-controls-revealed")

        if !element("player.pause").isHittable { try tap("player.surface") }
        try tap("player.pause")
        try tap("player.skipForward")
        screenshot("player-paused-and-seeked")
        try tap("player.audio")
        screenshot("audio-tracks")
        app.tap()
        if !element("player.subtitles").isHittable { try tap("player.surface") }
        try tap("player.subtitles")
        screenshot("subtitle-tracks")
        app.tap()
        if !element("player.info").isHittable { try tap("player.surface") }
        try tap("player.info")
        XCTAssertTrue(element("player.info.title").waitForExistence(timeout: 10))
        XCTAssertEqual(element("player.info.title").label, try XCTUnwrap(fixture["movieTitle"] as? String))
        screenshot("content-info")
        try tap("player.info.close")
        try assertFullscreen()

        XCUIDevice.shared.orientation = .landscapeLeft
        expectation(for: NSPredicate { _, _ in self.app.frame.width > self.app.frame.height }, evaluatedWith: nil)
        waitForExpectations(timeout: 15)
        try assertFullscreen()
        screenshot("fullscreen-landscape")
        XCUIDevice.shared.orientation = .portrait
        expectation(for: NSPredicate { _, _ in self.app.frame.height > self.app.frame.width }, evaluatedWith: nil)
        waitForExpectations(timeout: 15)
        try assertFullscreen()
        screenshot("fullscreen-portrait")

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        app.activate()
        try checkSystemPrompt()
        XCTAssertTrue(element("player.surface").waitForExistence(timeout: 20), "Player view must survive background/resume")
        screenshot("resumed-player")
        let lifecycleProof = XCTAttachment(string: "{\"background\":true,\"resumed\":true}")
        lifecycleProof.name = "peartube-proof-background-resume"; lifecycleProof.lifetime = .keepAlways; add(lifecycleProof)
        if !element("player.back").isHittable { try tap("player.surface") }
        try tap("player.back")
        XCTAssertTrue(row.waitForExistence(timeout: 15), "Back must return directly to the library")
        XCTAssertFalse(element("player.surface").exists, "Back must close playback, not reveal an inline player")
        app.terminate()
        app.launchArguments = ["-peartube-e2e", "-peartube-storage", try XCTUnwrap(fixture["storage"] as? String)]
        app.launch()
        try checkSystemPrompt()
        XCTAssertTrue(row.waitForExistence(timeout: 150), "Subscriptions must survive app restart")
        screenshot("library-after-restart")
    }

    func testSettingsPersistenceAndReceiverHandoff() throws {
        let movie = try XCTUnwrap(fixture["movieKey"] as? String)
        let receiver = try XCTUnwrap(fixture["receiverId"] as? String)
        XCTAssertTrue(element("library.entry.\(movie)").waitForExistence(timeout: 150))
        try tap("library.settings")
        XCTAssertTrue(element("settings.tracker").waitForExistence(timeout: 10))
        XCTAssertEqual(element("settings.tracker").value as? String, fixture["tracker"] as? String)
        screenshot("network-settings")
        try tap("settings.close")
        try tap("library.hood")
        let rawState = element("hood.rawState")
        for _ in 0..<10 where !rawState.exists { app.swipeUp() }
        XCTAssertTrue(rawState.waitForExistence(timeout: 10))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(rawState.label.utf8)) as? [String: Any])
        let apiURL = try XCTUnwrap(URL(string: try XCTUnwrap(state["apiUrl"] as? String)))
        app.navigationBars.buttons["Done"].firstMatch.tap()
        try tap("library.entry.\(movie)")
        XCTAssertTrue(element("player.surface").waitForExistence(timeout: 45))
        try assertFullscreen()
        if !element("player.cast").isHittable { try tap("player.surface") }
        try tap("player.cast")
        XCTAssertTrue(element("cast.receiver.\(receiver)").waitForExistence(timeout: 30), "A nearby TV must appear without entering an address or pairing link")
        screenshot("automatic-tv-discovery")
        XCUIDevice.shared.press(.home)
        app.activate()
        try checkSystemPrompt()
        XCTAssertTrue(element("cast.receiver.\(receiver)").waitForExistence(timeout: 30), "TV discovery must recover after background/resume")
        try tap("cast.code.\(receiver)")
        try tap("cast.pairCode")
        element("cast.pairCode").typeText(try XCTUnwrap(fixture["pairCode"] as? String) + "\n")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.keyboards.firstMatch)
        waitForExpectations(timeout: 10)
        try tap("cast.pair")
        try tap("cast.remote", timeout: 30)
        XCTAssertTrue(element("remote.pause").waitForExistence(timeout: 15))
        let pause = element("remote.pause")
        let before = pause.label
        try tap("remote.pause")
        expectation(for: NSPredicate { _, _ in pause.exists && pause.label != before }, evaluatedWith: nil)
        waitForExpectations(timeout: 15)
        try tap("remote.skipForward")
        screenshot("cast-remote")
        try tap("remote.switchLocal")
        XCTAssertTrue(element("player.surface").waitForExistence(timeout: 30), "Transfer back must reopen native playback")
        try assertFullscreen()
        screenshot("transferred-back-to-phone")
        if !element("player.cast").isHittable { try tap("player.surface") }
        try tap("player.cast")
        try tap("cast.receiver.\(receiver)")
        try tap("cast.remote", timeout: 30)
        try tap("remote.stop")
        XCTAssertFalse(element("cast.remote").waitForExistence(timeout: 2), "Stop must detach the remote session")
        try tap("library.entry.\(movie)")
        XCTAssertTrue(element("player.surface").waitForExistence(timeout: 45))
        if !element("player.cast").isHittable { try tap("player.surface") }
        try tap("player.cast")
        try tap("cast.receiver.\(receiver)")
        try tap("cast.remote", timeout: 30)
        try tap("remote.close")
        let streamOpened = expectation(description: "The real loopback API SSE stream sends data")
        let streamClosed = expectation(description: "Settings restart closes the real API SSE stream")
        let eventTask = Task {
            do {
                let (bytes, response) = try await URLSession.shared.bytes(from: apiURL.appendingPathComponent("v1/events"))
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    var opened = false
                    for try await line in bytes.lines {
                        if !opened && (line.hasPrefix(":") || line.hasPrefix("data:")) { opened = true; streamOpened.fulfill() }
                    }
                }
            } catch { /* Closing the old server can end the stream with a connection error. */ }
            streamClosed.fulfill()
        }
        defer { eventTask.cancel() }
        wait(for: [streamOpened], timeout: 15)
        try tap("library.settings")
        try tap("settings.save")
        XCTAssertTrue(element("library.entry.\(movie)").waitForExistence(timeout: 150), "Saving settings with an attached cast and API event subscriber must restart the node")
        XCTAssertFalse(element("cast.remote").exists, "The old cast controller must not survive node replacement")
        wait(for: [streamClosed], timeout: 20)
        let restartProof = XCTAttachment(string: "{\"opened\":true,\"closed\":true}")
        restartProof.name = "peartube-proof-api-sse-restart"; restartProof.lifetime = .keepAlways; add(restartProof)
        screenshot("settings-restart-after-cast")
    }
}

final class FirstRunTests: XCTestCase {
    private let app = XCUIApplication()
    private var addSource: XCUIElement { app.buttons["library.addSource"] }
    private var closeSettings: XCUIElement { app.buttons["settings.close"] }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(bootstrap: String? = nil) {
        app.launchArguments = ["-peartube-storage", "first-run-\(UUID().uuidString)"]
        if let bootstrap { app.launchArguments += ["-peartube-bootstrap", bootstrap] }
        app.launch()
        requireApp()
    }

    private func requireApp() {
        XCTAssertFalse(XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch.exists,
                       "A system prompt is in front. No input was sent.")
    }

    private func assertEmptyLibrary() {
        XCTAssertFalse(closeSettings.waitForExistence(timeout: 2), "Settings opened without a tap")
        XCTAssertTrue(addSource.waitForExistence(timeout: 10))
        XCTAssertTrue(addSource.isHittable, "The empty library must not be behind a sheet")
    }

    private func scrollTo(_ control: XCUIElement) {
        for _ in 0..<8 {
            requireApp()
            if control.exists && control.isHittable { return }
            app.swipeUp()
        }
        XCTFail("Could not reach the control")
    }

    private func openNodeDiagnostics() -> XCUIElement {
        requireApp()
        app.buttons["library.hood"].tap()
        let raw = app.staticTexts["hood.rawState"]
        for _ in 0..<12 where !raw.exists { requireApp(); app.swipeUp() }
        return raw
    }

    private func checkNode(minimumPeers: Int) throws -> Int {
        let raw = openNodeDiagnostics()
        var peers = 0
        let running = NSPredicate { _, _ in
            guard raw.exists, let state = try? JSONSerialization.jsonObject(with: Data(raw.label.utf8)) as? [String: Any],
                  let writer = state["writer"] as? String, writer.count == 64,
                  let count = state["peers"] as? Int, count >= minimumPeers else { return false }
            peers = count
            return true
        }
        expectation(for: running, evaluatedWith: nil)
        waitForExpectations(timeout: 30)
        requireApp()
        app.navigationBars.buttons["Done"].tap()
        return peers
    }

    func testFirstLaunchShowsEmptyLibraryNotSettings() throws {
        // Bootstrap was enough to suppress the first-run sheet on older versions.
        // Check this launch, including the worker's status, without any network argument.
        launch()
        assertEmptyLibrary()
        _ = try checkNode(minimumPeers: 0)
    }

    func testBlankSaveKeepsNetworkSettingAfterRelaunch() throws {
        launch()
        // Test Save independently of which screen opened first.
        if !closeSettings.exists { addSource.tap() }
        let lan = app.switches["settings.lan"]
        scrollTo(lan)
        let before = try XCTUnwrap(lan.value as? String)
        lan.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let changed = try XCTUnwrap(lan.value as? String)
        XCTAssertNotEqual(before, changed)

        let save = app.buttons["settings.save"]
        scrollTo(save)
        XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(closeSettings.waitForNonExistence(timeout: 10), "Save rejected empty channel fields")
        assertEmptyLibrary()

        app.terminate()
        app.launch()
        requireApp()
        assertEmptyLibrary()
        addSource.tap()
        scrollTo(lan)
        XCTAssertEqual(lan.value as? String, changed)
    }

    @MainActor private func waitForFixture(title: String, bootstrap: String) async throws {
        // Discard the probe's search cache and connections before the measured launch.
        let deadline = ProcessInfo.processInfo.systemUptime + 120
        func timeLeft() -> TimeInterval { max(0, deadline - ProcessInfo.processInfo.systemUptime) }
        launch(bootstrap: bootstrap)
        defer { app.terminate() }
        let raw = openNodeDiagnostics()
        var address: String?
        let listening = expectation(for: NSPredicate { _, _ in
            guard raw.exists, let state = (try? JSONSerialization.jsonObject(with: Data(raw.label.utf8))) as? [String: Any] else { return false }
            address = state["apiUrl"] as? String
            return address != nil
        }, evaluatedWith: nil)
        await fulfillment(of: [listening], timeout: timeLeft())
        let api = try XCTUnwrap(URL(string: try XCTUnwrap(address)))
        XCTAssertEqual(api.host, "127.0.0.1")
        var request = URLRequest(url: api.appendingPathComponent("v1/search/global"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": title])

        let finished = XCTestExpectation(description: "Fixture readiness: the probe must find \(title) within 120 seconds")
        let probe = Task {
            defer { finished.fulfill() }
            while true {
                try Task.checkCancellation()
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard let rows = reply?["results"] as? [[String: Any]] else { throw URLError(.cannotParseResponse) }
                if rows.contains(where: { $0["title"] as? String == title }) { return }
                try await Task.sleep(for: .seconds(2))
            }
        }
        let result = await XCTWaiter.fulfillment(of: [finished], timeout: timeLeft())
        probe.cancel()
        XCTAssertEqual(result, .completed, finished.expectationDescription)
        try await probe.value
    }

    @MainActor func testGlobalSearchPlaysWithoutAccount() async throws {
        guard let url = Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json"),
              let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
              let title = fixture["firstRunTitle"] as? String else {
            throw XCTSkip("Supply the fixture from ios/first-run-network.mjs --serve.")
        }
        let bootstrap = try XCTUnwrap(fixture["bootstrap"] as? String)
        XCTAssertFalse(bootstrap.isEmpty)
        try await waitForFixture(title: title, bootstrap: bootstrap)
        launch(bootstrap: bootstrap)
        assertEmptyLibrary()
        requireApp(); app.buttons["nav.search"].tap()
        let search = app.textFields["search.field"]
        requireApp(); search.tap(); search.typeText(title + "\n")
        let hits = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'global.play.'"))
        let play = hits.firstMatch
        XCTAssertTrue(play.waitForExistence(timeout: 120), "No global result for the fixture film")
        XCTAssertEqual(hits.count, 1)
        XCTAssertTrue(app.staticTexts[title].exists)
        let peers = try checkNode(minimumPeers: 1)
        scrollTo(play); play.tap()

        let picture = app.descendants(matching: .any).matching(identifier: "player.surface").firstMatch
        XCTAssertTrue(picture.waitForExistence(timeout: 30))
        // The picture's value is "elapsed of duration", even after the controls hide.
        func elapsed() -> Int {
            guard let value = picture.value as? String, let clock = value.split(separator: " ").first else { return 0 }
            return clock.split(separator: ":").compactMap { Int($0) }.reduce(0) { $0 * 60 + $1 }
        }
        let start = elapsed()
        let advanced = expectation(for: NSPredicate { _, _ in elapsed() >= start + 2 }, evaluatedWith: nil)
        await fulfillment(of: [advanced], timeout: 40)
        XCTAssertFalse(app.staticTexts["player.error"].exists)
        let evidence = XCTAttachment(string: "\(title): \(peers) public peer(s); playback from \(start) to \(elapsed()) seconds.")
        evidence.name = "first-run-playback"; evidence.lifetime = .keepAlways; add(evidence)

        // Search and playback above must work before the first Save. The same empty
        // account must also save; bootstrap alone hid the old automatic sheet.
        let back = app.buttons["player.back"]
        requireApp()
        if !back.isHittable { picture.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap() }
        back.tap()
        requireApp(); app.buttons["library.settings"].tap()
        let save = app.buttons["settings.save"]
        scrollTo(save); save.tap()
        XCTAssertTrue(closeSettings.waitForNonExistence(timeout: 10) && !app.alerts.firstMatch.exists &&
                      search.exists && search.isHittable, "Save rejected the empty account")
    }
}
