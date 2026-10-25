import Foundation
import Testing

@testable import MapleAPI

/// The services endpoints require `start_time`/`end_time`, and the server
/// validates them with `^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]00:00)$`. A
/// local-timezone string is a runtime 400, not a compile error — which is
/// exactly the kind of bug that ships.
/// Serialized: `ignoresDeviceTimeZone` mutates process-wide timezone state, and
/// Swift Testing runs suites in parallel by default.
@Suite("Time window", .serialized)
struct TimeWindowTests {
	private let pattern = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]00:00)$/

	@Test("Formats as ISO-8601 UTC with a trailing Z")
	func formatsAsUTC() throws {
		let formatted = ResolvedTimeWindow.format(Date(timeIntervalSince1970: 1_800_000_000))
		#expect(formatted.wholeMatch(of: pattern) != nil)
		#expect(formatted == "2027-01-15T08:00:00.000Z")
	}

	/// A half-hour offset catches a formatter that silently used the device
	/// timezone — a whole-hour offset can coincidentally still look plausible.
	@Test("Stays UTC under a half-hour-offset device timezone")
	func ignoresDeviceTimeZone() throws {
		let original = NSTimeZone.default
		defer { NSTimeZone.default = original }
		NSTimeZone.default = try #require(TimeZone(identifier: "Asia/Kolkata"))

		let formatted = ResolvedTimeWindow.format(Date(timeIntervalSince1970: 1_800_000_000))
		#expect(formatted.wholeMatch(of: pattern) != nil)
		#expect(formatted == "2027-01-15T08:00:00.000Z")
	}

	/// An un-snapped `Date()` makes every request URL unique, defeating the
	/// API's edge and bucket caches and restarting every `.task(id:)`.
	@Test("Snaps the window end down to the minute")
	func snapsToMinute() throws {
		let now = Date(timeIntervalSince1970: 1_800_000_037.482)
		let resolved = TimeWindow.last24Hours.resolve(now: now)

		#expect(resolved.end.timeIntervalSince1970 == 1_800_000_000)
		#expect(resolved.endTime.hasSuffix(":00.000Z"))
		#expect(resolved.end.timeIntervalSince(resolved.start) == 24 * 3600)
	}

	@Test("Resolving twice within the same minute yields an identical window")
	func isStableWithinAMinute() throws {
		let first = TimeWindow.lastHour.resolve(now: Date(timeIntervalSince1970: 1_800_000_001))
		let second = TimeWindow.lastHour.resolve(now: Date(timeIntervalSince1970: 1_800_000_059))
		#expect(first == second)
	}

	@Test("Every window stays within the server's 7-day ceiling", arguments: TimeWindow.allCases)
	func withinServerCeiling(window: TimeWindow) throws {
		// MAX_LIST_RANGE_SECONDS in packages/query-engine/src/limits.ts.
		#expect(window.duration <= 7 * 24 * 3600)
	}

	/// (window seconds, target points, bucket the web picks)
	static let webBuckets: [(Double, Int, Int)] = [
		(3600, 48, 60), (21600, 48, 300), (86400, 48, 1800), (604800, 48, 14400),
		(3600, 100, 60), (86400, 100, 900), (300, 48, 60),
	]

	@Test("Buckets match the web dashboard's ladder", arguments: webBuckets)
	func bucketsMatchWebLadder(case: (Double, Int, Int)) {
		let end = Date(timeIntervalSince1970: 1_800_000_000)
		let window = ResolvedTimeWindow(start: end.addingTimeInterval(-`case`.0), end: end)
		#expect(window.bucketSeconds(targetPoints: `case`.1) == `case`.2)
	}

	@Test("A short window keeps at least six buckets")
	func shortWindowKeepsSixBuckets() {
		let end = Date(timeIntervalSince1970: 1_800_000_000)
		// 2h at 4 points rounds to 30 minutes, which would leave four buckets.
		let window = ResolvedTimeWindow(start: end.addingTimeInterval(-7200), end: end)
		#expect(window.bucketSeconds(targetPoints: 4) == 900)
	}

	@Test("Round-trips the timestamps the API returns")
	func parsesApiTimestamps() throws {
		let withFraction = try #require(ResolvedTimeWindow.parse("2026-08-17T12:34:56.789Z"))
		#expect(ResolvedTimeWindow.format(withFraction) == "2026-08-17T12:34:56.789Z")

		// Bucket boundaries come back without fractional seconds.
		let whole = try #require(ResolvedTimeWindow.parse("2026-08-17T12:00:00Z"))
		#expect(ResolvedTimeWindow.format(whole) == "2026-08-17T12:00:00.000Z")

		#expect(ResolvedTimeWindow.parse("not a timestamp") == nil)
	}
}
