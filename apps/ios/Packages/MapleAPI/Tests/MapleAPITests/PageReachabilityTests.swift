import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

private let now = Date(timeIntervalSince1970: 1_795_742_040)

private func shift(startingIn seconds: TimeInterval, lasting length: TimeInterval = 7 * 86_400) -> OnCallViewerShift {
	let start = now.addingTimeInterval(seconds)
	return OnCallViewerShift(
		scheduleId: "onc_platform", scheduleName: "Platform primary", start: start,
		end: start.addingTimeInterval(length), isOverride: false, continues: false
	)
}

private let onCall = OnCallViewerState.onCall(.init(shift: shift(startingIn: -86_400), end: .continues))

/// Everything on: permission, banners, sound, Time Sensitive, and a registration.
private let healthy = PageReachability(authorization: .authorized)

@Suite("Page reachability")
struct PageReachabilityTests {
	@Test("A phone with everything on is reachable")
	func reachable() {
		#expect(healthy.verdict == .reachable)
		#expect(healthy.problem == nil)
	}

	@Test("Denied permission sends the user to Settings: iOS will not ask again")
	func denied() {
		let problem = PageReachability(authorization: .denied).problem
		#expect(problem == .permissionDenied)
		#expect(problem?.title == "Pages will not reach this phone")
		#expect(problem?.detail == "Notifications are turned off for Maple.")
		#expect(problem?.fixTitle == "Turn on notifications")
		#expect(problem?.fix == .openSettings)
	}

	@Test("Permission never asked for is asked for in the app")
	func notDetermined() {
		let problem = PageReachability(authorization: .notDetermined).problem
		#expect(problem == .permissionNotAsked)
		#expect(problem?.title == "Pages will not reach this phone")
		#expect(problem?.detail == "Maple has not been allowed to send notifications yet.")
		#expect(problem?.fixTitle == "Allow notifications")
		#expect(problem?.fix == .requestPermission)
	}

	@Test("Provisional permission delivers quietly, which is not how a page should arrive")
	func provisional() {
		let problem = PageReachability(authorization: .provisional).problem
		#expect(problem == .deliveredQuietly)
		#expect(problem?.title == "Pages arrive quietly on this phone")
		#expect(problem?.detail == "Maple may only deliver quietly, with no banner or sound.")
		#expect(problem?.fixTitle == "Open settings")
		#expect(problem?.fix == .openSettings)
	}

	@Test("Banners off means a page would not show")
	func alertsOff() {
		let problem = PageReachability(authorization: .authorized, alertsEnabled: false).problem
		#expect(problem == .alertsOff)
		#expect(problem?.title == "Pages will not show on this phone")
		#expect(problem?.detail == "Banners are turned off for Maple.")
		#expect(problem?.fixTitle == "Open settings")
		#expect(problem?.fix == .openSettings)
	}

	@Test("Sound off means a page would arrive silently")
	func soundOff() {
		let problem = PageReachability(authorization: .authorized, soundEnabled: false).problem
		#expect(problem == .soundOff)
		#expect(problem?.title == "Pages arrive without a sound")
		#expect(problem?.detail == "Sounds are turned off for Maple.")
		#expect(problem?.fixTitle == "Open settings")
		#expect(problem?.fix == .openSettings)
	}

	@Test("Time Sensitive off means Focus can hold a page back")
	func timeSensitiveOff() {
		let problem = PageReachability(authorization: .authorized, timeSensitiveEnabled: false).problem
		#expect(problem == .timeSensitiveOff)
		#expect(problem?.title == "Focus can hold back a page")
		#expect(problem?.detail == "Time Sensitive notifications are off for Maple.")
		#expect(problem?.fixTitle == "Open settings")
		#expect(problem?.fix == .openSettings)
	}

	@Test("A phone the server does not hold is registered again")
	func notRegistered() {
		let problem = PageReachability(authorization: .authorized, registration: .missing).problem
		#expect(problem == .notRegistered)
		#expect(problem?.title == "This phone is not registered for pages")
		#expect(problem?.detail == "Maple could not register it to receive pages.")
		#expect(problem?.fixTitle == "Try again")
		#expect(problem?.fix == .retryRegistration)
	}

	@Test("A registration still on its way is not a problem yet")
	func pendingRegistration() {
		#expect(PageReachability(authorization: .authorized, registration: .pending).verdict == .reachable)
	}

	@Test("Only the most severe problem is reported, in the order the cases are declared")
	func order() {
		// Everything wrong at once, then put right one step at a time.
		var facts = PageReachability(
			authorization: .denied, alertsEnabled: false, soundEnabled: false, timeSensitiveEnabled: false,
			registration: .missing
		)
		var reported: [PageReachability.Problem] = []
		func report() { if let problem = facts.problem { reported.append(problem) } }

		report()
		facts.authorization = .notDetermined
		report()
		facts.authorization = .provisional
		report()
		facts.authorization = .authorized
		report()
		facts.alertsEnabled = true
		report()
		facts.soundEnabled = true
		report()
		facts.timeSensitiveEnabled = true
		report()
		facts.registration = .registered

		#expect(reported == PageReachability.Problem.allCases)
		#expect(facts.verdict == .reachable)
	}
}

@Suite("Who is warned about reachability")
struct PageReachabilityWarningTests {
	private let denied = PageReachability(authorization: .denied)

	@Test("Someone on call is warned")
	func onCallNow() {
		#expect(onCall.expectsPages(now: now))
		#expect(denied.warning(for: onCall, now: now) == .permissionDenied)
	}

	@Test("A shift starting within 7 days is warned about, one further off is not")
	func upcomingShift() {
		let soon = OnCallViewerState.offCall(next: shift(startingIn: 6 * 86_400))
		let atTheLine = OnCallViewerState.offCall(next: shift(startingIn: 7 * 86_400))
		let later = OnCallViewerState.offCall(next: shift(startingIn: 7 * 86_400 + 60))
		#expect(denied.warning(for: soon, now: now) == .permissionDenied)
		#expect(denied.warning(for: atTheLine, now: now) == .permissionDenied)
		#expect(denied.warning(for: later, now: now) == nil)
	}

	@Test("Someone with no shifts is never warned")
	func noShifts() {
		#expect(!OnCallViewerState.noShifts.expectsPages(now: now))
		#expect(denied.warning(for: .noShifts, now: now) == nil)
	}

	@Test("A reachable phone raises no warning, on call or not")
	func reachablePhone() {
		#expect(healthy.warning(for: onCall, now: now) == nil)
		#expect(healthy.warning(for: .noShifts, now: now) == nil)
	}
}

@Suite("Test page result")
struct TestPageResultTests {
	@Test("One phone reached reads as this phone")
	func sentToOne() {
		let result = TestPageResult(configured: true, sent: 1)
		#expect(result.outcome == .sent)
		#expect(result.message == "Sent to this phone. It should arrive in a few seconds.")
	}

	@Test("Several phones reached are counted, even when another failed")
	func sentToSeveral() {
		let result = TestPageResult(configured: true, sent: 2, failed: 1)
		#expect(result.outcome == .sent)
		#expect(result.message == "Sent to 2 phones.")
	}

	@Test("All counts zero on a configured deployment means no phone is registered")
	func noPhone() {
		let result = TestPageResult(configured: true, sent: 0)
		#expect(result.outcome == .noPhone)
		#expect(
			result.message == "No phone is registered for you here. Open Maple on your phone and allow notifications."
		)
		// A phone the push platform had dropped is no longer registered either.
		#expect(TestPageResult(configured: true, sent: 0, unregistered: 1).outcome == .noPhone)
	}

	@Test("A deployment without push credentials says so, whatever the counts")
	func notConfigured() {
		let result = TestPageResult(configured: false, sent: 0)
		#expect(result.outcome == .notConfigured)
		#expect(result.message == "Push is not set up on this deployment.")
	}

	@Test("Phones that could not be sent to, and none that could, is a failure")
	func failed() {
		let result = TestPageResult(configured: true, sent: 0, failed: 1)
		#expect(result.outcome == .failed)
		#expect(result.message == "The test page could not be sent.")
		#expect(result.message == TestPageResult.failureMessage)
	}
}

private final class TestPageTransport: ClientTransport, @unchecked Sendable {
	private(set) var request: HTTPRequest?

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		self.request = request
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (
			response,
			HTTPBody(#"{"object":"mobile_test_page","configured":true,"sent":2,"failed":0,"unregistered":1}"#)
		)
	}
}

private struct StaticTokens: MapleTokenProvider {
	func token(forceRefresh: Bool) async throws -> String? { "session-token" }
}

@Suite("Sending a test page")
struct SendTestPageTests {
	@Test("POSTs to the test page endpoint and reads the counts back")
	func sends() async throws {
		let transport = TestPageTransport()
		let client = MapleClient(
			tokens: StaticTokens(), serverURL: URL(string: "https://api.maple.test")!, transport: transport
		)

		let result = try await client.sendTestPage()
		#expect(result == TestPageResult(configured: true, sent: 2, failed: 0, unregistered: 1))

		let request = try #require(transport.request)
		#expect(request.method == .post)
		#expect(request.path == "/v2/mobile_devices/test_page")
	}
}
