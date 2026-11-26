import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

// The world these tests read: Friday 27 November 2026, 01:14 UTC, the caller
// `user_me` on call for Platform primary until Monday 08:00.

private let generatedAt = "2026-11-27T01:14:00.000Z"
private let windowEndsAt = "2026-12-11T01:14:00.000Z"

/// A timestamp that will not parse lands in the distant past, where no expectation holds.
private func at(_ text: String) -> Date {
	ResolvedTimeWindow.parse(text) ?? .distantPast
}

private func shift(_ userId: String, _ startsAt: String, _ endsAt: String, override: Bool = false) -> [String: Any] {
	["user_id": userId, "starts_at": startsAt, "ends_at": endsAt, "is_override": override]
}

private func myShift(_ scheduleId: String, _ name: String, _ startsAt: String, _ endsAt: String) -> [String: Any] {
	["schedule_id": scheduleId, "schedule_name": name, "starts_at": startsAt, "ends_at": endsAt, "is_override": false]
}

private func schedule(
	_ id: String, _ name: String, shifts: [[String: Any]], now: [String: Any]? = nil, next: [String: Any]? = nil,
	gaps: [[String]] = [], summary: String = "Weekly, hands off Mon 09:00"
) -> [String: Any] {
	[
		"id": id,
		"name": name,
		"time_zone": "Europe/Berlin",
		"rotation_summary": summary,
		"on_call_now": now ?? NSNull(),
		"next": next ?? NSNull(),
		"shifts": shifts,
		"coverage_gaps": gaps.map { ["starts_at": $0[0], "ends_at": $0[1]] },
	]
}

// Computed, not stored: a global `[String: Any]` is not Sendable.
private var platformShifts: [[String: Any]] {
	[
		shift("user_me", "2026-11-23T08:00:00.000Z", "2026-11-30T08:00:00.000Z"),
		shift("user_priya", "2026-11-30T08:00:00.000Z", "2026-12-05T09:00:00.000Z"),
		shift("user_dana", "2026-12-05T09:00:00.000Z", "2026-12-05T19:00:00.000Z", override: true),
		shift("user_priya", "2026-12-05T19:00:00.000Z", "2026-12-07T08:00:00.000Z"),
		shift("user_marco", "2026-12-07T08:00:00.000Z", windowEndsAt),
	]
}

private var platform: [String: Any] {
	schedule(
		"onc_platform", "Platform primary", shifts: platformShifts, now: platformShifts[0], next: platformShifts[1]
	)
}

private var paymentsPrimaryShifts: [[String: Any]] {
	[
		shift("user_dana", "2026-11-20T17:00:00.000Z", "2026-11-27T17:00:00.000Z"),
		shift("user_marco", "2026-11-27T17:00:00.000Z", "2026-12-04T17:00:00.000Z"),
		shift("user_dana", "2026-12-04T17:00:00.000Z", windowEndsAt),
	]
}

private var paymentsSecondaryShifts: [[String: Any]] {
	[
		shift("user_marco", "2026-11-26T08:00:00.000Z", "2026-12-03T08:00:00.000Z"),
		shift("user_me", "2026-12-03T08:00:00.000Z", "2026-12-10T08:00:00.000Z"),
		// Nobody in `people` carries this id.
		shift("user_ghost", "2026-12-10T08:00:00.000Z", windowEndsAt),
	]
}

private var pipelineShifts: [[String: Any]] {
	[
		shift("user_priya", "2026-11-28T07:00:00.000Z", "2026-12-01T07:00:00.000Z"),
		shift("user_marco", "2026-12-01T07:00:00.000Z", "2026-12-04T07:00:00.000Z"),
		shift("user_priya", "2026-12-05T07:00:00.000Z", windowEndsAt),
	]
}

/// The four schedules in the server's order, by name.
private var allSchedules: [[String: Any]] {
	[
		schedule(
			"onc_pipeline", "Data pipeline", shifts: pipelineShifts, next: pipelineShifts[0],
			gaps: [[generatedAt, "2026-11-28T07:00:00.000Z"], ["2026-12-04T07:00:00.000Z", "2026-12-05T07:00:00.000Z"]],
			summary: "2 layers"
		),
		schedule(
			"onc_pay1", "Payments primary", shifts: paymentsPrimaryShifts, now: paymentsPrimaryShifts[0],
			next: paymentsPrimaryShifts[1]
		),
		schedule(
			"onc_pay2", "Payments secondary", shifts: paymentsSecondaryShifts, now: paymentsSecondaryShifts[0],
			next: paymentsSecondaryShifts[1]
		),
		platform,
	]
}

private var allMyShifts: [[String: Any]] {
	[
		myShift("onc_platform", "Platform primary", "2026-11-23T08:00:00.000Z", "2026-11-30T08:00:00.000Z"),
		myShift("onc_pay2", "Payments secondary", "2026-12-03T08:00:00.000Z", "2026-12-10T08:00:00.000Z"),
		myShift("onc_platform", "Platform primary", "2026-12-14T08:00:00.000Z", "2026-12-21T08:00:00.000Z"),
	]
}

/// An overview as the wire carries it, with the fields a case needs overridden.
private func makeOverview(_ overrides: [String: Any] = [:]) throws -> OnCallOverview {
	var json: [String: Any] = [
		"object": "oncall_overview",
		"generated_at": generatedAt,
		"organization_id": "org_2abcDEF",
		"user_id": "user_me",
		"schedule_window_ends_at": windowEndsAt,
		"schedules": allSchedules,
		"my_shifts": allMyShifts,
		"people": [
			["user_id": "user_me", "name": "Alex Chen"],
			["user_id": "user_priya", "name": "Priya Shah"],
			["user_id": "user_dana", "name": "Dana Kim"],
			["user_id": "user_marco", "name": "Marco Ruiz"],
		],
	]
	json.merge(overrides) { _, new in new }
	return try JSONDecoder().decode(OnCallOverview.self, from: JSONSerialization.data(withJSONObject: json))
}

private var utc: Calendar {
	var calendar = Calendar(identifier: .gregorian)
	calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
	return calendar
}

@Suite("On-call viewer state")
struct OnCallViewerStateTests {
	@Test("A started shift is the one the viewer is on, with when it ends and who takes over")
	func onCallNow() throws {
		let now = at(generatedAt)
		let state = try makeOverview().viewerState(now: now)
		guard case .onCall(let current) = state else {
			Issue.record("expected on call, got \(state)")
			return
		}
		#expect(current.shift.scheduleName == "Platform primary")
		#expect(current.until == at("2026-11-30T08:00:00.000Z"))
		#expect(current.handoff == .to(userId: "user_priya"))
		#expect(current.otherSchedules == 0)
		let headline = state.headline(now: now, calendar: utc)
		#expect(headline.lead == "You are on call")
		#expect(headline.detail == "· 3d 6h left on Platform primary")
	}

	@Test("Between shifts the viewer is off call, and the next shift is named")
	func offCall() throws {
		let now = at("2026-11-30T09:00:00.000Z")
		let state = try makeOverview().viewerState(now: now)
		guard case .offCall(let next) = state else {
			Issue.record("expected off call, got \(state)")
			return
		}
		#expect(next.scheduleId == "onc_pay2")
		#expect(next.start == at("2026-12-03T08:00:00.000Z"))
		let headline = state.headline(now: now, calendar: utc)
		#expect(headline.lead == "You are off call")
		#expect(headline.detail == "· next shift in 3 days on Payments secondary")
	}

	@Test("Nobody in a rotation has no shifts, and neither does someone whose shifts all ended")
	func noShifts() throws {
		let now = at(generatedAt)
		let none = try makeOverview(["my_shifts": [[String: Any]]()]).viewerState(now: now)
		#expect(none == .noShifts)
		#expect(none.headline(now: now).detail == "· no shifts in the next 60 days")

		let later = at("2027-01-10T00:00:00.000Z")
		#expect(try makeOverview().viewerState(now: later) == .noShifts)
	}

	@Test("On two schedules at once, the nearest handoff leads and the other is counted")
	func severalSchedules() throws {
		let now = at(generatedAt)
		let both = try makeOverview([
			"my_shifts": [
				myShift("onc_platform", "Platform primary", "2026-11-23T08:00:00.000Z", "2026-11-30T08:00:00.000Z"),
				myShift("onc_pay1", "Payments primary", "2026-11-26T17:00:00.000Z", "2026-11-28T17:00:00.000Z"),
			]
		]).viewerState(now: now)
		guard case .onCall(let current) = both else {
			Issue.record("expected on call, got \(both)")
			return
		}
		#expect(current.shift.scheduleName == "Payments primary")
		#expect(current.otherSchedules == 1)
		#expect(both.headline(now: now).detail == "· 1d 15h left on Payments primary and 1 more schedule")
	}

	@Test("A shift's progress runs from 0 at its start to 1 at its handoff")
	func progress() throws {
		let shift = OnCallViewerShift(
			scheduleId: "onc_platform", scheduleName: "Platform primary",
			start: at("2026-11-23T08:00:00.000Z"), end: at("2026-11-30T08:00:00.000Z"), isOverride: false
		)
		let current = OnCallViewerState.Current(shift: shift, until: shift.end, handoff: .unknown)
		#expect(current.progress(now: shift.start) == 0)
		#expect(current.progress(now: at("2026-11-26T20:00:00.000Z")) == 0.5)
		#expect(current.progress(now: at("2026-12-01T00:00:00.000Z")) == 1)
	}

	@Test("A shift whose dates will not parse is left out, not guessed at")
	func unreadableDates() throws {
		let now = at(generatedAt)
		let broken = try makeOverview([
			"my_shifts": [myShift("onc_platform", "Platform primary", "last Monday", "2026-11-30T08:00:00.000Z")]
		])
		#expect(broken.viewerShifts(now: now).isEmpty)
		#expect(broken.viewerState(now: now) == .noShifts)
	}
}

@Suite("On-call wording")
struct OnCallWordingTests {
	@Test("Time left reads in the two largest units")
	func remaining() throws {
		let now = at(generatedAt)
		#expect(OnCallWording.remaining(until: at("2026-11-30T08:00:00.000Z"), now: now) == "3d 6h left")
		#expect(OnCallWording.remaining(until: now.addingTimeInterval(45 * 60), now: now) == "45m left")
		#expect(OnCallWording.remaining(until: now.addingTimeInterval(20), now: now) == "under 1m left")
		#expect(OnCallWording.remaining(until: now.addingTimeInterval(-600), now: now) == "under 1m left")
	}

	@Test("Lead time counts minutes and hours inside a day, then calendar days")
	func lead() throws {
		let now = at(generatedAt)
		#expect(OnCallWording.lead(to: now.addingTimeInterval(12 * 60), now: now, calendar: utc) == "in 12m")
		#expect(OnCallWording.lead(to: now.addingTimeInterval(5.5 * 3600), now: now, calendar: utc) == "in 5h 30m")
		#expect(OnCallWording.lead(to: now, now: now, calendar: utc) == "now")
		// Thursday 08:00 from Friday 01:14: six calendar days on.
		#expect(OnCallWording.lead(to: at("2026-12-03T08:00:00.000Z"), now: now, calendar: utc) == "in 6 days")
		#expect(OnCallWording.lead(to: at("2026-12-14T08:00:00.000Z"), now: now, calendar: utc) == "in 17 days")
		#expect(OnCallWording.lead(to: at("2026-11-28T02:00:00.000Z"), now: now, calendar: utc) == "in 1 day")
		// The same instant is a different number of days in a zone already on Saturday.
		var auckland = utc
		auckland.timeZone = try #require(TimeZone(identifier: "Pacific/Auckland"))
		let late = at("2026-11-27T10:00:00.000Z")
		#expect(OnCallWording.lead(to: at("2026-12-03T12:00:00.000Z"), now: late, calendar: utc) == "in 6 days")
		#expect(OnCallWording.lead(to: at("2026-12-03T12:00:00.000Z"), now: late, calendar: auckland) == "in 7 days")
	}

	@Test("The caller is You, a known id is its name, and an unknown one is a teammate")
	func names() throws {
		let overview = try makeOverview()
		#expect(overview.name(of: "user_me") == "You")
		#expect(overview.name(of: "user_priya") == "Priya Shah")
		#expect(overview.name(of: "user_ghost") == "A teammate")
		#expect(overview.name(of: "user_me", midSentence: true) == "you")
		#expect(overview.name(of: "user_ghost", midSentence: true) == "a teammate")
		#expect(overview.isViewer("user_me"))
		#expect(!overview.isViewer("user_priya"))
	}

	@Test("A handoff reads as who takes over, or that nobody does, or nothing when unknown")
	func handoffPhrases() throws {
		let overview = try makeOverview()
		#expect(overview.handsOffPhrase(.to(userId: "user_priya")) == "hands off to Priya Shah")
		#expect(overview.handsOffPhrase(.to(userId: "user_me")) == "hands off to you")
		#expect(overview.handsOffPhrase(.nobody) == "nobody takes over")
		#expect(overview.handsOffPhrase(.unknown) == nil)
		#expect(overview.thenPhrase(.to(userId: "user_ghost")) == "then a teammate")
		#expect(overview.thenPhrase(.nobody) == "then nobody")
		#expect(overview.thenPhrase(.unknown) == nil)
	}
}

@Suite("On-call schedules")
struct OnCallScheduleTests {
	@Test("Each schedule says who holds it and until when, the viewer's first and uncovered ones last")
	func rows() throws {
		let rows = try makeOverview().scheduleRows(now: at(generatedAt))
		#expect(rows.map(\.name) == ["Platform primary", "Payments primary", "Payments secondary", "Data pipeline"])
		#expect(rows.map(\.whoLabel) == ["You", "Dana Kim", "Marco Ruiz", "Nobody"])
		#expect(rows.map(\.who) == [.viewer, .person(userId: "user_dana"), .person(userId: "user_marco"), .nobody])
		#expect(
			rows.map(\.until) == [
				at("2026-11-30T08:00:00.000Z"), at("2026-11-27T17:00:00.000Z"),
				at("2026-12-03T08:00:00.000Z"),
				// Nobody: when the gap ends.
				at("2026-11-28T07:00:00.000Z"),
			]
		)
		#expect(rows.map(\.isUncovered) == [false, false, false, true])
	}

	@Test("A row follows the clock past the shift the server called current")
	func rowsLater() throws {
		let overview = try makeOverview()
		let platform = try #require(overview.schedule(id: "onc_platform"))
		let row = overview.scheduleRow(for: platform, now: at("2026-11-30T09:00:00.000Z"))
		#expect(row.whoLabel == "Priya Shah")
		#expect(row.until == at("2026-12-05T09:00:00.000Z"))

		let secondary = try #require(overview.schedule(id: "onc_pay2"))
		let unnamed = overview.scheduleRow(for: secondary, now: at("2026-12-10T09:00:00.000Z"))
		#expect(unnamed.whoLabel == "A teammate")
	}

	@Test("A handoff names the next person, a gap, or nothing past the window")
	func handoffs() throws {
		let overview = try makeOverview()
		let end = overview.windowEnd
		let pipeline = try #require(overview.schedule(id: "onc_pipeline"))
		let periods = pipeline.periods
		#expect(pipeline.handoff(after: periods[0], windowEnd: end).to == .to(userId: "user_marco"))
		// Marco's shift ends into the second gap.
		let gap = pipeline.handoff(after: periods[1], windowEnd: end)
		#expect(gap.to == .nobody)
		#expect(gap.at == at("2026-12-04T07:00:00.000Z"))
		// The last shift is cut at the window's end, so what follows is not known.
		#expect(pipeline.handoff(after: periods[2], windowEnd: end).to == .unknown)

		// One of the viewer's shifts past the window: its schedule cannot say who follows.
		let far = try #require(overview.viewerShifts(now: at(generatedAt)).last)
		#expect(overview.handoff(after: far).to == .unknown)
	}

	@Test("A person's own back-to-back shifts are one stretch")
	func ownOverride() throws {
		let shifts = [
			shift("user_me", "2026-11-23T08:00:00.000Z", "2026-11-28T08:00:00.000Z"),
			shift("user_me", "2026-11-28T08:00:00.000Z", "2026-11-29T08:00:00.000Z", override: true),
			shift("user_priya", "2026-11-29T08:00:00.000Z", windowEndsAt),
		]
		let overview = try makeOverview(["schedules": [schedule("onc_platform", "Platform primary", shifts: shifts, now: shifts[0])]])
		let platform = try #require(overview.schedule(id: "onc_platform"))
		let now = at(generatedAt)
		guard case .covered(_, let until, let handoff) = platform.status(now: now, windowEnd: overview.windowEnd) else {
			Issue.record("expected the schedule to be covered")
			return
		}
		#expect(until == at("2026-11-29T08:00:00.000Z"))
		#expect(handoff == .to(userId: "user_priya"))
		#expect(overview.upcomingHandoffs(on: platform, now: now).map(\.name) == ["Priya Shah"])
	}

	@Test("A schedule nobody holds says who picks it up, when anyone does")
	func uncovered() throws {
		let overview = try makeOverview()
		let pipeline = try #require(overview.schedule(id: "onc_pipeline"))
		guard case .uncovered(let next?) = pipeline.status(now: at(generatedAt), windowEnd: overview.windowEnd)
		else {
			Issue.record("expected the schedule to be uncovered with a shift ahead")
			return
		}
		#expect(next.userId == "user_priya")

		let empty = try makeOverview(["schedules": [schedule("onc_empty", "Empty", shifts: [])]])
		let row = empty.scheduleRow(for: try #require(empty.schedule(id: "onc_empty")), now: at(generatedAt))
		#expect(row.who == .nobody)
		#expect(row.until == nil)
	}

	@Test("Upcoming lists every handoff ahead and marks the override")
	func upcoming() throws {
		let overview = try makeOverview()
		let platform = try #require(overview.schedule(id: "onc_platform"))
		let rows = overview.upcomingHandoffs(on: platform, now: at(generatedAt))
		#expect(rows.map(\.name) == ["Priya Shah", "Dana Kim", "Priya Shah", "Marco Ruiz"])
		#expect(rows.map(\.isOverride) == [false, true, false, false])
		#expect(rows.first?.at == at("2026-11-30T08:00:00.000Z"))
		#expect(Set(rows.map(\.id)).count == rows.count)

		let secondary = try #require(overview.schedule(id: "onc_pay2"))
		let mine = overview.upcomingHandoffs(on: secondary, now: at(generatedAt))
		#expect(mine.map(\.name) == ["You", "A teammate"])
		#expect(mine.map(\.isViewer) == [true, false])
	}
}

@Suite("On-call coverage")
struct OnCallCoverageTests {
	@Test("Gaps list earliest first, and the one under way says so")
	func gapRows() throws {
		let overview = try makeOverview()
		let now = at(generatedAt)
		let rows = overview.gapRows(now: now)
		#expect(rows.count == 2)
		#expect(rows.map(\.scheduleName) == ["Data pipeline", "Data pipeline"])
		#expect(rows[0].isNow)
		#expect(rows[0].detail == "Nobody is on call right now")
		#expect(rows[0].end == at("2026-11-28T07:00:00.000Z"))
		#expect(!rows[1].isNow)
		#expect(rows[1].detail == "Nobody is on call for 1d")

		#expect(overview.gapRows(now: now, scheduleId: "onc_platform").isEmpty)
		#expect(overview.gapRows(now: now, scheduleId: "onc_pipeline").count == 2)
		// A gap that is over is not a gap any more.
		#expect(overview.gapRows(now: at("2026-11-29T00:00:00.000Z")).count == 1)
	}

	@Test("A gap that runs to the window's end has no known end")
	func openEndedGap() throws {
		let shifts = [shift("user_priya", "2026-11-23T08:00:00.000Z", "2026-12-01T08:00:00.000Z")]
		let overview = try makeOverview([
			"schedules": [
				schedule(
					"onc_platform", "Platform primary", shifts: shifts, now: shifts[0],
					gaps: [["2026-12-01T08:00:00.000Z", windowEndsAt]]
				)
			]
		])
		let row = try #require(overview.gapRows(now: at(generatedAt)).first)
		#expect(row.isOpenEnded)
		#expect(row.detail == "Nobody is scheduled after this")
		let platform = try #require(overview.schedule(id: "onc_platform"))
		#expect(platform.handoff(after: platform.periods[0], windowEnd: overview.windowEnd).to == .nobody)
	}

	@Test("The strip has one lane per person, the override marked, covering the whole window")
	func lanes() throws {
		let overview = try makeOverview()
		let platform = try #require(overview.schedule(id: "onc_platform"))
		let coverage = try #require(overview.coverage(of: platform, calendar: utc))

		#expect(coverage.dayCount == 14)
		#expect(coverage.lanes.map(\.name) == ["You", "Priya Shah", "Dana Kim", "Marco Ruiz"])
		#expect(coverage.lanes.map(\.isViewer) == [true, false, false, false])
		#expect(coverage.lanes.map(\.segments.count) == [1, 2, 1, 1])
		#expect(coverage.lanes[2].segments.map(\.isOverride) == [true])
		#expect(coverage.lanes[1].segments.map(\.isOverride) == [false, false])
		#expect(coverage.hasOverrides)
		#expect(coverage.gaps.isEmpty)

		// The viewer's shift started before the window, so its lane starts at 0.
		let mine = coverage.lanes[0].segments[0]
		#expect(mine.start == 0)
		let hours = 14.0 * 24
		#expect(abs(mine.end - (3 * 24 + 6 + 46.0 / 60) / hours) < 1e-9)
		// Dana covers ten hours of the fourteen days.
		#expect(abs(coverage.lanes[2].share - 10 / hours) < 1e-9)
		#expect(abs(coverage.lanes.reduce(0) { $0 + $1.share } - 1) < 1e-9)
	}

	@Test("Gaps take their own stretches, and people and gaps add up to the window")
	func gapsInTheStrip() throws {
		let overview = try makeOverview()
		let pipeline = try #require(overview.schedule(id: "onc_pipeline"))
		let coverage = try #require(overview.coverage(of: pipeline, calendar: utc))

		#expect(coverage.lanes.map(\.name) == ["Priya Shah", "Marco Ruiz"])
		#expect(coverage.lanes[0].segments.count == 2)
		#expect(coverage.gaps.count == 2)
		#expect(coverage.gaps[0].start == 0)
		#expect(!coverage.hasOverrides)
		let covered = coverage.lanes.reduce(0) { $0 + $1.share }
		let uncovered = coverage.gaps.reduce(0) { $0 + $1.length }
		#expect(abs(covered + uncovered - 1) < 1e-9)
	}

	@Test("Days are cut at midnight in the calendar's zone, the first and last partial")
	func days() throws {
		let overview = try makeOverview()
		let platform = try #require(overview.schedule(id: "onc_platform"))
		let coverage = try #require(overview.coverage(of: platform, calendar: utc))

		// 01:14 on the 27th to 01:14 on the 11th touches fifteen calendar days.
		#expect(coverage.days.count == 15)
		#expect(coverage.days.first?.start == 0)
		#expect(coverage.days.last?.end == 1)
		#expect(coverage.days[1].date == at("2026-11-28T00:00:00.000Z"))
		let hours = 14.0 * 24
		#expect(abs(coverage.days[0].end - (22 + 46.0 / 60) / hours) < 1e-9)
		#expect(abs((coverage.days[1].end - coverage.days[1].start) - 24 / hours) < 1e-9)
		for (day, next) in zip(coverage.days, coverage.days.dropFirst()) {
			#expect(day.end == next.start)
		}
	}

	@Test("An overview whose window will not parse draws no strip")
	func unreadableWindow() throws {
		let overview = try makeOverview(["schedule_window_ends_at": "soon"])
		let platform = try #require(overview.schedule(id: "onc_platform"))
		#expect(overview.coverage(of: platform, calendar: utc) == nil)
	}
}

private final class OverviewTransport: ClientTransport, @unchecked Sendable {
	private(set) var lastRequest: HTTPRequest?
	private let responseJSON: String

	init(responseJSON: String) {
		self.responseJSON = responseJSON
	}

	func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws
		-> (HTTPResponse, HTTPBody?)
	{
		lastRequest = request
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(responseJSON))
	}
}

private struct OverviewTokens: MapleTokenProvider {
	func token(forceRefresh: Bool) async throws -> String? { "test-token" }
}

@Suite("On-call overview read")
struct OnCallOverviewReadTests {
	@Test("The client reads the overview from its one endpoint, nulls and all")
	func read() async throws {
		let body = try JSONSerialization.data(withJSONObject: [
			"object": "oncall_overview",
			"generated_at": generatedAt,
			"organization_id": "org_2abcDEF",
			"user_id": "user_me",
			"schedule_window_ends_at": windowEndsAt,
			"schedules": allSchedules,
			"my_shifts": allMyShifts,
			"people": [["user_id": "user_me", "name": "Alex Chen"]],
		])
		let transport = OverviewTransport(responseJSON: String(decoding: body, as: UTF8.self))
		let client = MapleClient(
			tokens: OverviewTokens(), serverURL: try #require(URL(string: "https://api.maple.test")), transport: transport
		)
		let overview = try await client.scoped(toEnvironment: "staging").onCallOverview()

		let path = try #require(transport.lastRequest?.path)
		#expect(path.hasSuffix("/v2/alerts/oncall_overview"))
		#expect(overview.schedules.count == 4)
		#expect(overview.schedule(id: "onc_pipeline")?.onCallNow == nil)
		#expect(overview.schedule(id: "onc_platform")?.onCallNow?.userId == "user_me")
	}
}
