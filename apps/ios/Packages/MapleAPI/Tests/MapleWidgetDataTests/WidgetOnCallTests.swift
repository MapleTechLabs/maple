import Foundation
import Testing

@testable import MapleWidgetData

// The world these tests read: Friday 27 November 2026, 02:14 UTC. The owner of
// the credential, `user_me`, is on call for Platform primary until Monday 09:00,
// and Dana Kim covers Priya Shah's Wednesday from 10:00 to 22:00.

private let generatedAt = "2026-11-27T02:14:00.000Z"
private let windowEndsAt = "2026-12-11T02:14:00.000Z"
private let organizationId = "org_oncall"
private let apiBase = URL(string: "https://api.maple.test")!
private let path = "/v2/widget_summary/oncall"

private func at(_ text: String) -> Date {
	WidgetJSON.parse(text) ?? .distantPast
}

private let now = at(generatedAt)

/// UTC and a 24 hour clock, so "Mon 09:00" does not depend on the machine.
private var utc: WidgetTimeStyle {
	var calendar = Calendar(identifier: .gregorian)
	calendar.timeZone = .gmt
	return WidgetTimeStyle(calendar: calendar, locale: Locale(identifier: "en_GB"))
}

/// A clock time as the test style writes it. Whether 9 o'clock is "09:00" or
/// "9:00" is ICU's to decide and differs between OS releases, so no test pins it.
private func hm(_ hours: Int, _ minutes: Int = 0) -> String {
	WidgetTime.clock(at("2026-11-27T00:00:00.000Z").addingTimeInterval(Double(hours * 3600 + minutes * 60)), style: utc)
}

/// Where the 60 day window cuts `on_call_now` and `my_shifts`.
private let cutAt = "2027-01-26T02:14:00.000Z"

/// `continues` is left off unless it is given, as a server from before it does.
private func shift(
	_ userId: String, _ startsAt: String, _ endsAt: String, override: Bool = false, continues: Bool? = nil
) -> String {
	let last = continues.map { #","continues":\#($0)"# } ?? ""
	return #"{"user_id":"\#(userId)","starts_at":"\#(startsAt)","ends_at":"\#(endsAt)","is_override":\#(override)\#(last)}"#
}

private func myShift(
	_ scheduleId: String, _ name: String, _ startsAt: String, _ endsAt: String, continues: Bool? = nil
) -> String {
	let last = continues.map { #","continues":\#($0)"# } ?? ""
	return
		#"{"schedule_id":"\#(scheduleId)","schedule_name":"\#(name)","starts_at":"\#(startsAt)","ends_at":"\#(endsAt)","is_override":false\#(last)}"#
}

private func schedule(
	_ id: String, _ name: String, shifts: [String], now: String?, next: String?, gaps: [(String, String)] = []
) -> String {
	let gapList = gaps.map { #"{"starts_at":"\#($0.0)","ends_at":"\#($0.1)"}"# }.joined(separator: ",")
	// `layers` is not a key this build knows: it has to be ignored, not refused.
	return """
		{"id":"\(id)","name":"\(name)","time_zone":"Europe/Berlin","rotation_summary":"Weekly, hands off Mon 09:00",
		 "layers":[{"id":"onl_1"}],"on_call_now":\(now ?? "null"),"next":\(next ?? "null"),
		 "shifts":[\(shifts.joined(separator: ","))],"coverage_gaps":[\(gapList)]}
		"""
}

private let platformMine = myShift("onc_platform", "Platform primary", "2026-11-23T09:00:00.000Z", "2026-11-30T09:00:00.000Z")
private let paymentsMine = myShift("onc_pay2", "Payments secondary", "2026-12-03T09:00:00.000Z", "2026-12-10T09:00:00.000Z")
private let platformLater = myShift("onc_platform", "Platform primary", "2026-12-14T09:00:00.000Z", "2026-12-21T09:00:00.000Z")

/// The overview as the wire carries it. `platformHolder` is who has Platform
/// primary this week, so one world can be read on call and off call. `solo`
/// makes Platform primary and Payments primary rotations of one: the holder
/// and Dana Kim stay on call past both windows, and nobody takes over.
private func overviewJSON(
	organization: String = organizationId, platformHolder: String = "user_me",
	myShifts: [String] = [platformMine, paymentsMine, platformLater], withPeople: Bool = true, solo: Bool = false
) -> String {
	let platform =
		solo
		? [shift(platformHolder, "2026-11-23T09:00:00.000Z", windowEndsAt, continues: true)]
		: [
			shift(platformHolder, "2026-11-23T09:00:00.000Z", "2026-11-30T09:00:00.000Z"),
			shift("user_priya", "2026-11-30T09:00:00.000Z", "2026-12-02T10:00:00.000Z"),
			shift("user_dana", "2026-12-02T10:00:00.000Z", "2026-12-02T22:00:00.000Z", override: true),
			shift("user_priya", "2026-12-02T22:00:00.000Z", "2026-12-07T09:00:00.000Z"),
			shift("user_marco", "2026-12-07T09:00:00.000Z", windowEndsAt),
		]
	let paymentsPrimary =
		solo
		? [shift("user_dana", "2026-11-20T18:00:00.000Z", windowEndsAt, continues: true)]
		: [
			shift("user_dana", "2026-11-20T18:00:00.000Z", "2026-11-27T18:00:00.000Z"),
			shift("user_marco", "2026-11-27T18:00:00.000Z", "2026-12-04T18:00:00.000Z"),
			shift("user_dana", "2026-12-04T18:00:00.000Z", windowEndsAt),
		]
	// The whole stretch, cut where the 60 day window stops.
	let platformNow = solo ? shift(platformHolder, "2026-11-23T09:00:00.000Z", cutAt, continues: true) : platform[0]
	let paymentsPrimaryNow = solo ? shift("user_dana", "2026-11-20T18:00:00.000Z", cutAt, continues: true) : paymentsPrimary[0]
	let paymentsSecondary = [
		shift("user_marco", "2026-11-26T09:00:00.000Z", "2026-12-03T09:00:00.000Z"),
		shift("user_me", "2026-12-03T09:00:00.000Z", "2026-12-10T09:00:00.000Z"),
		// Nobody in `people` carries this id.
		shift("user_ghost", "2026-12-10T09:00:00.000Z", windowEndsAt),
	]
	let pipeline = [
		shift("user_priya", "2026-11-28T08:00:00.000Z", "2026-12-01T08:00:00.000Z"),
		shift("user_marco", "2026-12-01T08:00:00.000Z", "2026-12-04T08:00:00.000Z"),
		shift("user_priya", "2026-12-05T08:00:00.000Z", windowEndsAt),
	]
	// By name, as the server orders them.
	let schedules = [
		schedule(
			"onc_pipeline", "Data pipeline", shifts: pipeline, now: nil, next: pipeline[0],
			gaps: [(generatedAt, "2026-11-28T08:00:00.000Z"), ("2026-12-04T08:00:00.000Z", "2026-12-05T08:00:00.000Z")]
		),
		schedule(
			"onc_pay1", "Payments primary", shifts: paymentsPrimary, now: paymentsPrimaryNow, next: solo ? nil : paymentsPrimary[1]
		),
		schedule("onc_pay2", "Payments secondary", shifts: paymentsSecondary, now: paymentsSecondary[0], next: paymentsSecondary[1]),
		schedule("onc_platform", "Platform primary", shifts: platform, now: platformNow, next: solo ? nil : platform[1]),
	]
	let people = """
		,"people":[{"user_id":"user_me","name":"Alex Chen"},{"user_id":"user_priya","name":"Priya Shah"},
		 {"user_id":"user_dana","name":"Dana Kim"},{"user_id":"user_marco","name":"Marco Ruiz"}]
		"""
	return """
		{"object":"oncall_overview","generated_at":"\(generatedAt)","organization_id":"\(organization)",
		 "user_id":"user_me","schedule_window_ends_at":"\(windowEndsAt)","a_field_from_the_future":1,
		 "schedules":[\(schedules.joined(separator: ","))],"my_shifts":[\(myShifts.joined(separator: ","))]\(withPeople ? people : "")}
		"""
}

private func makeSnapshot(_ json: String = overviewJSON()) throws -> OnCallSnapshot {
	try WidgetJSON.decoder.decode(WidgetOnCallPayload.self, from: Data(json.utf8)).snapshot(organizationName: "acme-prod")
}

/// The same world with Priya on Platform primary, so the owner is off call
/// until Payments secondary on Thursday.
private func offCallSnapshot() throws -> OnCallSnapshot {
	try makeSnapshot(overviewJSON(platformHolder: "user_priya", myShifts: [paymentsMine, platformLater]))
}

/// The owner alone on Platform primary and Dana Kim alone on Payments primary,
/// both still on call where the read stops.
private func soloSnapshot() throws -> OnCallSnapshot {
	let mine = myShift("onc_platform", "Platform primary", "2026-11-23T09:00:00.000Z", cutAt, continues: true)
	return try makeSnapshot(overviewJSON(myShifts: [mine], solo: true))
}

@Suite("On-call widget snapshot")
struct OnCallSnapshotTests {
	@Test("Decodes what the server sends, ignoring keys it does not know")
	func decodes() throws {
		let snapshot = try makeSnapshot()
		#expect(snapshot.organizationId == organizationId)
		#expect(snapshot.organizationName == "acme-prod")
		#expect(snapshot.userId == "user_me")
		#expect(snapshot.generatedAt == now)
		#expect(snapshot.windowEnd == at(windowEndsAt))
		#expect(snapshot.schedules.map(\.name) == ["Data pipeline", "Payments primary", "Payments secondary", "Platform primary"])
		let platform = try #require(snapshot.schedule(id: "onc_platform"))
		#expect(platform.rotationSummary == "Weekly, hands off Mon 09:00")
		#expect(platform.onCallNow?.userId == "user_me")
		#expect(platform.shifts.count == 5)
		#expect(platform.shifts[2] == .init(
			userId: "user_dana", start: at("2026-12-02T10:00:00.000Z"), end: at("2026-12-02T22:00:00.000Z"), isOverride: true
		))
		#expect(snapshot.schedule(id: "onc_pipeline")?.gaps.count == 2)
		#expect(snapshot.myShifts.map(\.scheduleName) == ["Platform primary", "Payments secondary", "Platform primary"])
	}

	@Test("The owner is You, and an id nobody is listed under is a teammate")
	func names() throws {
		let snapshot = try makeSnapshot()
		#expect(snapshot.name(of: "user_me") == "You")
		#expect(snapshot.name(of: "user_me", midSentence: true) == "you")
		#expect(snapshot.name(of: "user_priya") == "Priya Shah")
		#expect(snapshot.name(of: "user_ghost") == "A teammate")
		#expect(snapshot.name(of: "user_ghost", midSentence: true) == "a teammate")
		#expect([snapshot.shortName(of: "user_me"), snapshot.shortName(of: "user_priya"), snapshot.shortName(of: "user_ghost")]
			== ["You", "Priya", "Teammate"])
		// A payload with no directory at all still decodes.
		#expect(try makeSnapshot(overviewJSON(withPeople: false)).name(of: "user_priya") == "A teammate")
	}

	@Test("On call: which schedule, until when, and who is next")
	func viewerOnCall() throws {
		let snapshot = try makeSnapshot()
		guard case .onCall(let current) = snapshot.viewerState(at: now) else {
			Issue.record("expected the owner on call")
			return
		}
		#expect(current.scheduleId == "onc_platform")
		#expect(current.scheduleName == "Platform primary")
		#expect(current.end == .handoff(at: at("2026-11-30T09:00:00.000Z"), to: "user_priya"))
		#expect(current.otherSchedules == 0)
		#expect(snapshot.thenPhrase(current.end) == "then Priya Shah")
		#expect(WidgetTime.span(try #require(current.end.date).timeIntervalSince(now)) == "3d 6h")
		#expect(snapshot.defaultSchedule(at: now)?.id == "onc_platform")
	}

	@Test("Off call: the next shift, and who has it before the owner")
	func viewerOffCall() throws {
		let snapshot = try offCallSnapshot()
		let friday = at("2026-11-27T12:00:00.000Z")
		guard case .offCall(let next) = snapshot.viewerState(at: friday) else {
			Issue.record("expected the owner off call")
			return
		}
		#expect(next.scheduleName == "Payments secondary")
		#expect(next.start == at("2026-12-03T09:00:00.000Z"))
		#expect(next.before == .person(userId: "user_marco"))
		#expect(snapshot.afterPhrase(next.before) == "after Marco Ruiz")
		#expect(WidgetTime.handoffTime(next.start, now: friday, compact: true, style: utc) == "Thu \(hm(9))")
		#expect(WidgetTime.lead(to: next.start, now: friday, calendar: utc.calendar) == "in 6 days")
		// Nothing picked and nobody's turn: the first schedule, in the server's order.
		#expect(snapshot.defaultSchedule(at: friday)?.id == "onc_pipeline")

		// The same snapshot drawn for a later entry: the shift has begun.
		guard case .onCall(let current) = snapshot.viewerState(at: at("2026-12-03T09:00:00.000Z")) else {
			Issue.record("expected the owner on call once the shift starts")
			return
		}
		#expect(current.scheduleId == "onc_pay2")
		#expect(snapshot.thenPhrase(current.end) == "then a teammate")
	}

	@Test("A shift that follows a gap, or lies past what was read, says so or says nothing")
	func predecessors() throws {
		// The owner takes Data pipeline on Saturday, after a stretch nobody covers.
		let mine = myShift("onc_pipeline", "Data pipeline", "2026-11-28T08:00:00.000Z", "2026-12-01T08:00:00.000Z")
		let gap = try makeSnapshot(overviewJSON(platformHolder: "user_priya", myShifts: [mine]))
		guard case .offCall(let afterGap) = gap.viewerState(at: now) else {
			Issue.record("expected the owner off call")
			return
		}
		#expect(afterGap.before == .nobody)
		#expect(gap.afterPhrase(afterGap.before) == "after a gap")

		// A shift past the window: the read does not reach who holds it before.
		let far = try makeSnapshot(overviewJSON(platformHolder: "user_priya", myShifts: [platformLater]))
		guard case .offCall(let later) = far.viewerState(at: now) else {
			Issue.record("expected the owner off call")
			return
		}
		#expect(later.before == .unknown)
		#expect(far.afterPhrase(later.before) == nil)
	}

	@Test("No shifts in the next 60 days")
	func viewerNoShifts() throws {
		let snapshot = try makeSnapshot(overviewJSON(platformHolder: "user_priya", myShifts: []))
		#expect(snapshot.viewerState(at: now) == .noShifts)
		#expect(snapshot.lockScreenText(at: now, style: utc).inline == "Off call · no shifts ahead")
		#expect(snapshot.pagesShiftLine(at: now, style: utc) == nil)
		// And once every shift it was sent has ended.
		#expect(try makeSnapshot().viewerState(at: at("2026-12-22T00:00:00.000Z")) == .noShifts)
	}

	@Test("On call now: the owner's schedule first, then the covered ones, then Nobody")
	func tableRows() throws {
		let snapshot = try makeSnapshot()
		let rows = snapshot.tableRows(at: now)
		#expect(rows.map(\.name) == ["Platform primary", "Payments primary", "Payments secondary", "Data pipeline"])
		#expect(rows.map(\.whoLabel) == ["You", "Dana Kim", "Marco Ruiz", "Nobody"])
		#expect(rows.map(\.who) == [.viewer, .person(userId: "user_dana"), .person(userId: "user_marco"), .nobody])
		#expect(rows.map(\.until) == [
			at("2026-11-30T09:00:00.000Z"), at("2026-11-27T18:00:00.000Z"), at("2026-12-03T09:00:00.000Z"),
			// The gap ends when the first shift ahead starts.
			at("2026-11-28T08:00:00.000Z"),
		])
		#expect(rows.map { $0.untilLabel(at: now, style: utc) } == ["Mon \(hm(9))", "Fri \(hm(18))", "3 Dec", "Sat \(hm(8))"])
		#expect(rows.map(\.isUncovered) == [false, false, false, true])
		#expect(rows.allSatisfy { !$0.hasNoHandoff })
	}

	@Test("The table drawn for a later entry follows the handoffs")
	func tableRowsLater() throws {
		let snapshot = try makeSnapshot()
		let saturday = snapshot.tableRows(at: at("2026-11-28T09:00:00.000Z"))
		#expect(saturday.map(\.name) == ["Platform primary", "Data pipeline", "Payments primary", "Payments secondary"])
		#expect(saturday.map(\.whoLabel) == ["You", "Priya Shah", "Marco Ruiz", "Marco Ruiz"])
		#expect(saturday[1].until == at("2026-12-01T08:00:00.000Z"))

		// Dana's override hands back to Priya, and nobody in `people` holds Payments secondary at the end.
		let late = snapshot.tableRows(at: at("2026-12-10T10:00:00.000Z"))
		#expect(late.first { $0.id == "onc_pay2" }?.whoLabel == "A teammate")
		let wednesday = snapshot.row(for: try #require(snapshot.schedule(id: "onc_platform")), at: at("2026-12-02T12:00:00.000Z"))
		#expect(wednesday.whoLabel == "Dana Kim")
		#expect(wednesday.until == at("2026-12-02T22:00:00.000Z"))
	}

	@Test("Still on call where the read stops: no handoff, no end time and no then, on every surface")
	func continuingStretch() throws {
		let snapshot = try soloSnapshot()
		let platform = try #require(snapshot.schedule(id: "onc_platform"))
		let payments = try #require(snapshot.schedule(id: "onc_pay1"))
		#expect(snapshot.status(of: platform, at: now) == .covered(by: try #require(platform.onCallNow), end: .continues))
		guard case .onCall(let current) = snapshot.viewerState(at: now) else {
			Issue.record("expected the owner on call")
			return
		}
		#expect(current.end == .continues)
		#expect(current.end.date == nil)
		#expect(snapshot.thenPhrase(current.end) == nil)

		// The table: nobody's until is the 14 or 60 day cut.
		let rows = snapshot.tableRows(at: now)
		#expect(rows.map(\.name) == ["Platform primary", "Payments primary", "Payments secondary", "Data pipeline"])
		#expect(rows.map(\.hasNoHandoff) == [true, true, false, false])
		#expect(rows.prefix(2).map(\.until) == [nil, nil])
		#expect(rows.map { $0.untilLabel(at: now, style: utc) } == ["No handoff", "No handoff", "3 Dec", "Sat \(hm(8))"])

		let text = snapshot.lockScreenText(at: now, style: utc)
		#expect([text.lead, text.detail, text.second] == ["On call", "Platform primary", "no handoff scheduled"])
		#expect(text.inline == "On call · no handoff")
		#expect(snapshot.pagesShiftLine(at: now, style: utc) == "Platform primary · no handoff scheduled")

		let mine = snapshot.scheduleLine(for: platform, at: now, style: utc)
		#expect(mine.who == .viewer)
		#expect("\(mine.whoLabel) \(mine.detail)" == "You · no handoff in the next 7 days")
		let danas = snapshot.scheduleLine(for: payments, at: now, style: utc)
		#expect("\(danas.whoLabel) \(danas.detail)" == "Dana Kim · no handoff in the next 7 days")

		// Drawn for the last entry of the timeline, a refresh later, it says the same.
		let later = now.addingTimeInterval(OnCallSnapshot.timelineHorizon)
		#expect(snapshot.lockScreenText(at: later, style: utc) == text)
		#expect(snapshot.row(for: payments, at: later).hasNoHandoff)
	}

	@Test("A stretch ends where its last back-to-back shift does, and only a cut that continues has no end")
	func stretchEnds() throws {
		let start = at("2026-11-23T09:00:00.000Z")
		let middle = at("2026-11-30T09:00:00.000Z")
		let windowEnd = at(windowEndsAt)
		func schedule(lastContinues: Bool) -> OnCallSnapshot.Schedule {
			.init(
				id: "onc_solo", name: "Solo",
				shifts: [
					.init(userId: "user_dana", start: start, end: middle),
					.init(userId: "user_dana", start: middle, end: windowEnd, continues: lastContinues),
				]
			)
		}
		// Her own next turn is no handoff, and the cut after it is not one either.
		let solo = schedule(lastContinues: true)
		#expect(solo.end(of: solo.shifts[0], windowEnd: windowEnd) == .continues)
		// A server from before `continues`: the read stops there and says no more.
		let older = schedule(lastContinues: false)
		#expect(older.end(of: older.shifts[0], windowEnd: windowEnd) == .unknown(at: windowEnd))

		// A real end past the 14 day window keeps its date.
		let snapshot = try makeSnapshot(
			overviewJSON(myShifts: [myShift("onc_platform", "Platform primary", "2026-11-23T09:00:00.000Z", "2026-12-20T09:00:00.000Z")], solo: true)
		)
		guard case .onCall(let current) = snapshot.viewerState(at: now) else {
			Issue.record("expected the owner on call")
			return
		}
		#expect(current.end == .unknown(at: at("2026-12-20T09:00:00.000Z")))
	}

	@Test("A payload or a stored snapshot without continues reads as false")
	func continuesAbsent() throws {
		let snapshot = try makeSnapshot()
		#expect(snapshot.schedules.flatMap(\.periods).allSatisfy { !$0.continues })
		#expect(snapshot.myShifts.allSatisfy { !$0.continues })
		// What a build from before the key left in the App Group.
		let stored = #"{"userId":"user_me","start":"2026-11-23T09:00:00.000Z","end":"2026-11-30T09:00:00.000Z","isOverride":false}"#
		#expect(try WidgetJSON.decoder.decode(OnCallSnapshot.Shift.self, from: Data(stored.utf8)).continues == false)
		let mine = #"{"scheduleId":"onc_platform","scheduleName":"Platform primary","start":"2026-11-23T09:00:00.000Z","end":"2026-11-30T09:00:00.000Z","isOverride":false}"#
		#expect(try WidgetJSON.decoder.decode(OnCallSnapshot.ViewerShift.self, from: Data(mine.utf8)).continues == false)
		// And it survives the trip through the App Group once it is there.
		let solo = try soloSnapshot()
		let data = try WidgetJSON.encoder.encode(solo)
		#expect(try WidgetJSON.decoder.decode(OnCallSnapshot.self, from: data) == solo)
		#expect(solo.myShifts.map(\.continues) == [true])
	}

	@Test("Where a window cut a stretch nothing changes: no change date and no countdown entries")
	func noChangeAtCut() throws {
		let snapshot = try soloSnapshot()
		let all = snapshot.changeDates(after: now, until: .distantFuture)
		#expect(!all.contains(at(cutAt)))
		// The read running out is still one, and it is the last.
		#expect(all.last == at(windowEndsAt))
		// With no time left to count there are no hourly entries: the one handoff
		// on another schedule, and the midnights.
		#expect(snapshot.timelineDates(from: now, calendar: utc.calendar) == [
			now, at("2026-11-28T00:00:00.000Z"), at("2026-11-28T08:00:00.000Z"), at("2026-11-29T00:00:00.000Z"),
		])
	}

	@Test("What a widget shows changes when a shift or a gap starts or ends")
	func changeDates() throws {
		let snapshot = try makeSnapshot()
		#expect(snapshot.changeDates(after: now, until: now.addingTimeInterval(48 * 3600)) == [
			at("2026-11-27T18:00:00.000Z"), at("2026-11-28T08:00:00.000Z"),
		])
		// Exclusive of `now`, inclusive of the horizon, and the read running out is a change.
		let week = snapshot.changeDates(after: at("2026-11-27T18:00:00.000Z"), until: at("2026-11-30T09:00:00.000Z"))
		#expect(week == [at("2026-11-28T08:00:00.000Z"), at("2026-11-30T09:00:00.000Z")])
		#expect(snapshot.changeDates(after: now, until: .distantFuture).contains(at(windowEndsAt)))
		#expect(snapshot.changeDates(after: now, until: .distantFuture).last == at("2026-12-21T09:00:00.000Z"))
	}

	@Test("A timeline has an entry wherever the coarse time left would otherwise go stale")
	func timelineDates() throws {
		let snapshot = try makeSnapshot()
		let dates = snapshot.timelineDates(from: now, calendar: utc.calendar)
		#expect(dates.first == now)
		#expect(dates == dates.sorted())
		#expect(dates.allSatisfy { $0 <= now.addingTimeInterval(OnCallSnapshot.timelineHorizon) })
		// Each change and each midnight is an entry.
		for expected in ["2026-11-27T18:00:00.000Z", "2026-11-28T08:00:00.000Z", "2026-11-28T00:00:00.000Z"] {
			#expect(dates.contains(at(expected)))
		}
		// "3d 6h" stays true from one entry to the next. The wording rounds down,
		// so the entry that replaces it lands a second past the whole hour.
		let until = at("2026-11-30T09:00:00.000Z")
		for (entry, next) in zip(dates, dates.dropFirst()) {
			let drawn = WidgetTime.span(until.timeIntervalSince(entry))
			#expect(drawn == WidgetTime.span(until.timeIntervalSince(next.addingTimeInterval(-1.5))), "stale after \(entry)")
		}
		#expect(WidgetTime.span(until.timeIntervalSince(dates[1])) == "3d 5h")

		// Off call, the entry that hands the lead to a ticking clock is a day before the shift.
		let offCall = try offCallSnapshot()
		let dayBefore = offCall.timelineDates(from: at("2026-12-01T12:00:00.000Z"), calendar: utc.calendar)
		#expect(dayBefore.contains(at("2026-12-02T09:00:01.000Z")))
	}

	@Test("The seven day strip: one lane per person, summing to the window, the override marked")
	func strip() throws {
		let snapshot = try makeSnapshot()
		let platform = try #require(snapshot.schedule(id: "onc_platform"))
		let strip = snapshot.strip(for: platform, at: now, style: utc)
		#expect(strip.start == at("2026-11-27T00:00:00.000Z"))
		#expect(strip.end == at("2026-12-04T00:00:00.000Z"))
		#expect(strip.days.map(\.letter) == ["F", "S", "S", "M", "T", "W", "T"])
		#expect(abs(strip.days[1].start - 1.0 / 7) < 1e-9)
		#expect(strip.days.last?.end == 1)

		#expect(strip.lanes.map(\.userId) == ["user_me", "user_priya", "user_dana"])
		#expect(strip.lanes.map(\.label) == ["You", "Priya", "Dana"])
		#expect(strip.lanes.map(\.isViewer) == [true, false, false])
		let hours = strip.lanes.map { ($0.share * 168).rounded() }
		#expect(hours == [81, 75, 12])
		#expect(abs(strip.lanes.reduce(0) { $0 + $1.share } - 1) < 1e-9)
		#expect(strip.gaps.isEmpty)

		// Priya's week is cut in two by the override, which is Dana's only stretch.
		#expect(strip.lanes[1].segments.count == 2)
		#expect(strip.lanes[1].segments.allSatisfy { !$0.isOverride })
		#expect(strip.lanes[2].segments.map(\.isOverride) == [true])
		#expect(abs(strip.lanes[2].segments[0].start - 130.0 / 168) < 1e-9)
		#expect(strip.overrideLine == "Dana Kim covers Wed \(hm(10)) to \(hm(22))")
	}

	@Test("The strip leaves what nobody covers as a gap, and names an override under way")
	func stripGapsAndOverrides() throws {
		let snapshot = try makeSnapshot()
		let pipeline = try #require(snapshot.schedule(id: "onc_pipeline"))
		let strip = snapshot.strip(for: pipeline, at: now, style: utc)
		#expect(strip.lanes.map(\.label) == ["Priya", "Marco"])
		#expect(strip.overrideLine == nil)
		// From the read to Saturday 08:00. The gap a week on lies past the window.
		#expect(strip.gaps.count == 1)
		let covered = strip.lanes.reduce(0) { $0 + $1.share } + strip.gaps.reduce(0) { $0 + $1.length }
		// The hours before the read are not known, so they are neither lane nor gap.
		#expect(abs(covered * 168 - (168 - 134.0 / 60)) < 1e-6)

		let platform = try #require(snapshot.schedule(id: "onc_platform"))
		let wednesday = at("2026-12-02T12:00:00.000Z")
		#expect(snapshot.strip(for: platform, at: wednesday, style: utc).overrideLine == "Dana Kim covers until Wed \(hm(22))")
		#expect(snapshot.strip(for: platform, at: wednesday, style: utc).days.first?.letter == "W")
		// The owner's own override is said in the second person.
		var mine = snapshot
		mine.userId = "user_dana"
		#expect(mine.strip(for: platform, at: now, style: utc).overrideLine == "You cover Wed \(hm(10)) to \(hm(22))")
	}

	@Test("The Schedule widget's line: who, until when, and who is next")
	func scheduleLine() throws {
		let snapshot = try makeSnapshot()
		let platform = snapshot.scheduleLine(for: try #require(snapshot.schedule(id: "onc_platform")), at: now, style: utc)
		#expect(platform.who == .viewer)
		#expect("\(platform.whoLabel) \(platform.detail)" == "You until Mon \(hm(9)) · then Priya Shah")
		let pipeline = snapshot.scheduleLine(for: try #require(snapshot.schedule(id: "onc_pipeline")), at: now, style: utc)
		#expect(pipeline.who == .nobody)
		#expect("\(pipeline.whoLabel) \(pipeline.detail)" == "Nobody until Sat \(hm(8)) · then Priya Shah")
		// The last shift runs to the end of what was read: nothing is claimed about what follows.
		let late = snapshot.scheduleLine(
			for: try #require(snapshot.schedule(id: "onc_pay1")), at: at("2026-12-09T12:00:00.000Z"), style: utc
		)
		#expect("\(late.whoLabel) \(late.detail)" == "Dana Kim until Fri \(hm(2, 14))")
		// Past the last shift that was read, the line still reads as a sentence.
		let empty = snapshot.scheduleLine(
			for: try #require(snapshot.schedule(id: "onc_pipeline")), at: at("2027-01-15T12:00:00.000Z"), style: utc
		)
		#expect("\(empty.whoLabel) \(empty.detail)" == "Nobody · no shift ahead")
	}

	@Test("The Lock Screen and the Pages widget's quiet line")
	func lockScreenAndPagesLine() throws {
		let onCall = try makeSnapshot()
		let text = onCall.lockScreenText(at: now, style: utc)
		#expect([text.lead, text.detail, text.second] == ["On call", "Platform primary", "until Mon \(hm(9))"])
		#expect(text.inline == "On call · until Mon \(hm(9))")
		#expect(onCall.pagesShiftLine(at: now, style: utc) == "Platform primary until Mon \(hm(9))")
		// The shift is over, and later the read no longer reaches the present.
		#expect(onCall.pagesShiftLine(at: at("2026-11-30T09:00:00.000Z"), style: utc) == nil)
		#expect(onCall.covers(at("2026-12-11T02:13:59.000Z")))
		#expect(!onCall.covers(at(windowEndsAt)))

		let offCall = try offCallSnapshot()
		let friday = at("2026-11-27T12:00:00.000Z")
		let off = offCall.lockScreenText(at: friday, style: utc)
		#expect([off.lead, off.detail, off.second] == ["Off call", "next Thu \(hm(9))", "Payments secondary"])
		#expect(off.inline == "Off call · next Thu \(hm(9))")
		#expect(offCall.pagesShiftLine(at: friday, style: utc) == nil)
	}

	@Test("Says the time left and the lead the way the app's on-call screens do")
	func wording() {
		// `IncidentWording.span` and `OnCallWording` in MapleAPI, string for string.
		#expect(WidgetTime.span(59) == "under 1m")
		#expect(WidgetTime.span(4 * 60) == "4m")
		#expect(WidgetTime.span(3600) == "1h")
		#expect(WidgetTime.span(65 * 60) == "1h 5m")
		#expect(WidgetTime.span(48 * 3600) == "2d")
		#expect(WidgetTime.span(49 * 3600 + 59 * 60) == "2d 1h")
		#expect(WidgetTime.remaining(until: at("2026-11-30T09:00:00.000Z"), now: now) == "3d 6h left")
		#expect(WidgetTime.remaining(until: now.addingTimeInterval(45 * 60), now: now) == "45m left")
		#expect(WidgetTime.remaining(until: now.addingTimeInterval(-5), now: now) == "under 1m left")

		let calendar = utc.calendar
		#expect(WidgetTime.lead(to: now, now: now, calendar: calendar) == "now")
		#expect(WidgetTime.lead(to: now.addingTimeInterval(12 * 60), now: now, calendar: calendar) == "in 12m")
		#expect(WidgetTime.lead(to: now.addingTimeInterval(5.5 * 3600), now: now, calendar: calendar) == "in 5h 30m")
		// Past a day it counts calendar days: 02:14 on Friday to 09:00 on Saturday is one.
		#expect(WidgetTime.lead(to: at("2026-11-28T09:00:00.000Z"), now: now, calendar: calendar) == "in 1 day")
		#expect(WidgetTime.lead(to: at("2026-12-03T09:00:00.000Z"), now: now, calendar: calendar) == "in 6 days")

		// In the style's zone and on its clock: 22:00 UTC is not 10 PM, nor 23:00 in Berlin.
		#expect(WidgetTime.clock(at("2026-12-02T22:00:00.000Z"), style: utc) == "22:00")
		#expect(WidgetTime.weekdayTime(at("2026-11-30T22:00:00.000Z"), style: utc) == "Mon 22:00")
		// A weekday names one day for six days; after that the date does.
		#expect(WidgetTime.handoffTime(at("2026-12-03T02:00:00.000Z"), now: now, style: utc) == "Thu \(hm(2))")
		#expect(WidgetTime.handoffTime(at("2026-12-07T09:00:00.000Z"), now: now, compact: true, style: utc) == "7 Dec")
	}

	@Test("The widgets' links open On call and the schedule, in the organization they show")
	func links() throws {
		#expect(OnCallWidgetKind.onCallURL(organizationId: "org_2abc")?.absoluteString == "maple://oncall?org=org_2abc")
		#expect(
			ScheduleWidgetKind.scheduleURL(id: "onc_platform", organizationId: "org_2abc")?.absoluteString
				== "maple://schedule/onc_platform?org=org_2abc"
		)
		// A Schedule widget with nothing to show still has somewhere to go.
		#expect(ScheduleWidgetKind.scheduleURL(id: nil, organizationId: nil)?.absoluteString == "maple://oncall")
		for target in [WidgetDeepLink.Target.onCall, .schedule(id: "onc_platform")] {
			let link = WidgetDeepLink(target: target, organizationId: "org_2abc")
			#expect(link.url.flatMap(WidgetDeepLink.init(url:)) == link)
		}
		let bare = try #require(URL(string: "maple://schedule?org=org_2abc"))
		#expect(WidgetDeepLink(url: bare)?.target == .onCall)
	}
}

// MARK: - The read

/// Answers from a script and keeps every request it was sent.
private actor ScriptedTransport: WidgetHTTPTransport {
	struct Reply: Sendable {
		var status: Int
		var body: String
	}

	private var replies: [String: Reply]
	/// What happens elsewhere on the phone while a request to a path is in flight.
	private let meanwhile: [String: @Sendable () -> Void]
	private(set) var requests: [URLRequest] = []

	init(_ replies: [String: Reply], meanwhile: [String: @Sendable () -> Void] = [:]) {
		self.replies = replies
		self.meanwhile = meanwhile
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		requests.append(request)
		guard let url = request.url, let reply = replies[url.path],
			let response = HTTPURLResponse(
				url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
				headerFields: ["Content-Type": "application/json"]
			)
		else { throw URLError(.notConnectedToInternet) }
		meanwhile[url.path]?()
		return (Data(reply.body.utf8), response)
	}

	func requests(to path: String) -> [URLRequest] { requests.filter { $0.url?.path == path } }
}

private final class MemoryKeyStore: DeviceKeyStoring, @unchecked Sendable {
	private let lock = NSLock()
	private var keys: [String: DeviceKey] = [:]

	func load(organizationId: String) -> DeviceKey? { lock.withLock { keys[organizationId] } }

	func generate(organizationId: String) throws -> DeviceKey {
		DeviceKey(organizationId: organizationId, isHardwareBacked: false, signer: SoftwareDeviceKey())
	}

	func save(_ key: DeviceKey) throws { lock.withLock { keys[key.organizationId] = key } }
	func delete(organizationId: String) { _ = lock.withLock { keys.removeValue(forKey: organizationId) } }
	func deleteAll() { lock.withLock { keys.removeAll() } }
}

private let tokenReply = ScriptedTransport.Reply(
	status: 200,
	body: #"{"object":"device_token","access_token":"t1","token_type":"DPoP","expires_in":3600,"scope":"widget_summary:read"}"#
)

private struct Harness {
	let suite = "widget-oncall-tests-\(UUID().uuidString)"
	let directory: URL
	let credentials: WidgetCredentialStore
	let keys = MemoryKeyStore()

	init() {
		directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(suite, isDirectory: true)
		credentials = WidgetCredentialStore(directory: directory)
	}

	/// A registered key and its record, as the app leaves them.
	func register(credentialId: String = "dcred_1") throws {
		let key = try keys.generate(organizationId: organizationId)
		try keys.save(key)
		credentials.saveDevice(
			DeviceCredential(
				organizationId: organizationId,
				credentialId: credentialId,
				jkt: key.thumbprint,
				apiBaseURL: apiBase,
				attested: false,
				expiresAt: now.addingTimeInterval(30 * 86_400),
				hardExpiresAt: now.addingTimeInterval(90 * 86_400),
				registeredAt: now,
				scopes: ["widget_summary:read"]
			)
		)
	}

	func client(_ transport: ScriptedTransport) -> WidgetOnCallClient {
		WidgetOnCallClient(credentials: credentials, keys: keys, session: transport, appGroupIdentifier: suite)
	}

	func working() -> ScriptedTransport {
		ScriptedTransport(["/v2/device_tokens": tokenReply, path: .init(status: 200, body: overviewJSON())])
	}

	/// What the app reads before deciding the registered key is still good.
	var isCredentialRejected: Bool {
		WidgetFetchStateStore(appGroupIdentifier: suite).load(organizationId: organizationId).isCredentialRejected
	}

	var lastRead: OnCallReadRecord? {
		WidgetSnapshotStore<OnCallReadRecord>.onCallRead(organizationId: organizationId, appGroupIdentifier: suite).load()
	}

	var stored: OnCallSnapshot? {
		WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId, appGroupIdentifier: suite).load()
	}

	func cleanUp() {
		try? FileManager.default.removeItem(at: directory)
		UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
	}
}

@Suite("On-call widget client", .serialized)
struct WidgetOnCallClientTests {
	@Test("Reads the overview with the device credential, and stores it")
	func refresh() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = harness.working()

		let outcome = await harness.client(transport).refresh(organizationId: organizationId, organizationName: "acme-prod", now: now)
		guard case .fetched(let snapshot) = outcome else {
			Issue.record("expected a snapshot, got \(outcome)")
			return
		}
		#expect(snapshot.organizationName == "acme-prod")
		#expect(snapshot.schedules.count == 4)
		// What comes back out of the App Group is what the views were handed.
		#expect(harness.stored == snapshot)
		#expect(harness.lastRead == OnCallReadRecord(outcome: .fetched, at: now, consecutiveFailures: 0))
		let request = try #require(await transport.requests(to: path).first)
		#expect(request.httpMethod == "GET")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP t1")
		#expect(request.value(forHTTPHeaderField: "DPoP") != nil)
	}

	@Test("Stores nothing for another organization's answer, a refusal, or no credential")
	func refreshFailures() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let none = await harness.client(ScriptedTransport([:])).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(none == .noCredential)

		try harness.register()
		let wrongOrganization = ScriptedTransport([
			"/v2/device_tokens": tokenReply,
			path: .init(status: 200, body: overviewJSON(organization: "org_other")),
		])
		#expect(await harness.client(wrongOrganization).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		let unreadable = ScriptedTransport(["/v2/device_tokens": tokenReply, path: .init(status: 200, body: #"{"object":"oncall_overview"}"#)])
		#expect(await harness.client(unreadable).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		let refused = ScriptedTransport(["/v2/device_tokens": tokenReply, path: .init(status: 403, body: "{}")])
		#expect(await harness.client(refused).refresh(organizationId: organizationId, organizationName: nil, now: now) == .needsApp)
		#expect(harness.stored == nil)
		// Every read leaves how it ended, and a run of failures is counted until one lands.
		#expect(harness.lastRead == OnCallReadRecord(outcome: .needsApp, at: now, consecutiveFailures: 4))
		_ = await harness.client(harness.working()).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(harness.lastRead == OnCallReadRecord(outcome: .fetched, at: now, consecutiveFailures: 0))
	}

	@Test("A failed read leaves the snapshot the widgets already have")
	func keepsLastSnapshot() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		_ = await harness.client(harness.working()).refresh(organizationId: organizationId, organizationName: "acme-prod", now: now)
		let before = try #require(harness.stored)
		let down = ScriptedTransport(["/v2/device_tokens": tokenReply, path: .init(status: 503, body: "{}")])
		#expect(await harness.client(down).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		#expect(harness.stored == before)
	}

	@Test("A revoked credential is recorded for the app to replace, and then nothing is sent with it")
	func revokedCredential() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		// The key is fine, the request is not allowed, or there is no network:
		// nothing a new key would fix.
		let forbidden = ScriptedTransport(["/v2/device_tokens": tokenReply, path: .init(status: 403, body: "{}")])
		_ = await harness.client(forbidden).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(await harness.client(ScriptedTransport([:])).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		#expect(!harness.isCredentialRejected)

		// A role change revoked the key: the token in hand is refused, and the
		// token endpoint no longer knows the key that would buy another.
		let revoked = ScriptedTransport([
			path: .init(status: 401, body: #"{"error":{"code":"invalid_token"}}"#),
			"/v2/device_tokens": .init(status: 401, body: #"{"error":{"code":"invalid_device_credential"}}"#),
		])
		#expect(await harness.client(revoked).refresh(organizationId: organizationId, organizationName: nil, now: now) == .needsApp)
		#expect(harness.isCredentialRejected)

		// Until the app replaces the key, a server that would answer is not asked.
		let silent = harness.working()
		#expect(await harness.client(silent).refresh(organizationId: organizationId, organizationName: nil, now: now) == .needsApp)
		#expect(await silent.requests.isEmpty)
		#expect(harness.stored == nil)
		#expect(harness.lastRead?.outcome == .needsApp)
	}

	@Test("A second widget woken beside the first is handed the snapshot just read")
	func freshSnapshotIsNotReadAgain() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = harness.working()
		let client = harness.client(transport)
		let first = await client.refresh(organizationId: organizationId, organizationName: "acme-prod", freshFor: 300, now: now)
		let second = await client.refresh(
			organizationId: organizationId, organizationName: "acme-prod", freshFor: 300, now: now.addingTimeInterval(120)
		)
		#expect(first == second)
		#expect(await transport.requests(to: path).count == 1)
		// Past the floor, or when the caller sets none, it reads.
		_ = await client.refresh(organizationId: organizationId, organizationName: nil, freshFor: 300, now: now.addingTimeInterval(301))
		_ = await client.refresh(organizationId: organizationId, organizationName: nil, now: now.addingTimeInterval(302))
		#expect(await transport.requests(to: path).count == 3)
	}

	@Test("An answer that arrives after sign-out, or after the key was replaced, stores nothing")
	func answerOutlivesCredential() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let answer = ScriptedTransport.Reply(status: 200, body: overviewJSON())
		// Sign-out removes the credentials first and the snapshots after them.
		let signedOut = ScriptedTransport(
			["/v2/device_tokens": tokenReply, path: answer], meanwhile: [path: { harness.credentials.clearAll() }]
		)
		#expect(await harness.client(signedOut).refresh(organizationId: organizationId, organizationName: nil, now: now) == .noCredential)
		#expect(await signedOut.requests(to: path).count == 1)
		#expect(harness.stored == nil)
		#expect(harness.lastRead == nil)

		// The next account registers its own key while the last one's read is out.
		try harness.register()
		let replaced = ScriptedTransport(
			["/v2/device_tokens": tokenReply, path: answer],
			meanwhile: [path: { try? harness.register(credentialId: "dcred_2") }]
		)
		#expect(await harness.client(replaced).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		#expect(harness.stored == nil)
		#expect(harness.lastRead == nil)

		// The server refusing the old key on its way out is not the new key's refusal:
		// recording it would stop the next account's widgets before their first read.
		let revoked = ScriptedTransport(
			["/v2/device_tokens": .init(status: 401, body: #"{"error":{"code":"invalid_device_credential"}}"#)],
			meanwhile: ["/v2/device_tokens": { try? harness.register(credentialId: "dcred_3") }]
		)
		#expect(await harness.client(revoked).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		#expect(!harness.isCredentialRejected)
		#expect(harness.lastRead == nil)

		// A read signed with the key on file is stored as ever.
		_ = await harness.client(harness.working()).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(harness.stored != nil)
		#expect(harness.lastRead?.outcome == .fetched)
	}

	@Test("A pick's identifier carries its organization, and an older bare one still reads")
	func pickIdentifier() {
		let pick = SchedulePick(scheduleId: "onc_platform", organizationId: "org_2abc")
		#expect(pick.identifier == "org_2abc/onc_platform")
		#expect(SchedulePick(identifier: pick.identifier) == pick)
		#expect(ScheduleEntity(pick: pick, name: nil).id == "org_2abc/onc_platform")

		// Stored before picks carried an organization: the id is left as it was.
		let bare = SchedulePick(identifier: "onc_platform")
		#expect(bare == SchedulePick(scheduleId: "onc_platform", organizationId: nil))
		#expect(bare.identifier == "onc_platform")
		#expect(ScheduleEntity(pick: bare, name: nil).id == "onc_platform")
		// Only an organization id is read as one.
		#expect(SchedulePick(identifier: "../credentials/onc_platform").organizationId == nil)
		#expect(SchedulePick(identifier: "org_2abc/").organizationId == nil)
	}

	@Test("A picked schedule keeps its organization through a sign-out, and nothing picked follows the app")
	func pickedOrganization() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		_ = await harness.client(harness.working()).refresh(organizationId: organizationId, organizationName: nil, now: now)
		let index = WidgetOrganizationIndex(appGroupIdentifier: harness.suite)
		index.record(memberships: [WidgetOrganization(id: "org_active", name: "Active"), WidgetOrganization(id: organizationId, name: "Other")])
		index.record(WidgetOrganization(id: "org_active", name: "Active"), isActive: true)
		func organization(showing pick: SchedulePick?) -> String? {
			SchedulePick.organizationId(showing: pick, appGroupIdentifier: harness.suite)
		}
		let pinned = SchedulePick(scheduleId: "onc_platform", organizationId: organizationId)
		let older = SchedulePick(identifier: "onc_platform")

		#expect(organization(showing: nil) == "org_active")
		#expect(organization(showing: pinned) == organizationId)
		// An older pick is found in the snapshot that holds it, else it follows the app.
		#expect(organization(showing: older) == organizationId)
		#expect(organization(showing: SchedulePick(identifier: "onc_deleted")) == "org_active")
		// A pick in an organization nothing was ever read for is still that organization's.
		#expect(organization(showing: SchedulePick(scheduleId: "onc_x", organizationId: "org_unread")) == "org_unread")

		let query = ScheduleEntityQuery(appGroupIdentifier: harness.suite)
		let resolved = try await query.entities(for: [pinned.identifier, older.identifier])
		#expect(resolved.map(\.id) == ["\(organizationId)/onc_platform", "onc_platform"])
		#expect(resolved.map(\.name) == ["Platform primary", "Platform primary"])
		#expect(resolved.map(\.organizationId) == [organizationId, nil])

		// Sign-out: the snapshots and the index go, and the pick does not move.
		WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId, appGroupIdentifier: harness.suite).clear()
		index.clear()
		#expect(organization(showing: pinned) == organizationId)
		#expect(organization(showing: older) == nil)
		#expect(organization(showing: nil) == nil)
		let after = try await query.entities(for: [pinned.identifier])
		#expect(after.map(\.pick) == [pinned])
		#expect(after.first?.name == nil)
	}

	@Test("The picker lists the active organization's schedules, each remembering it")
	func suggestedSchedules() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		_ = await harness.client(harness.working()).refresh(organizationId: organizationId, organizationName: nil, now: now)
		let query = ScheduleEntityQuery(appGroupIdentifier: harness.suite)
		#expect(try await query.suggestedEntities().isEmpty)

		WidgetOrganizationIndex(appGroupIdentifier: harness.suite)
			.record(WidgetOrganization(id: organizationId, name: "acme-prod"), isActive: true)
		let suggested = try await query.suggestedEntities()
		#expect(suggested.map(\.id) == ["onc_pipeline", "onc_pay1", "onc_pay2", "onc_platform"].map { "\(organizationId)/\($0)" })
		#expect(suggested.allSatisfy { $0.organizationId == organizationId })
	}

	@Test("A schedule is found in whichever organization's snapshot holds it")
	func storedHolding() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		_ = await harness.client(harness.working()).refresh(organizationId: organizationId, organizationName: nil, now: now)
		let index = WidgetOrganizationIndex(appGroupIdentifier: harness.suite)
		index.record(memberships: [WidgetOrganization(id: "org_active", name: "Active"), WidgetOrganization(id: organizationId, name: "Other")])
		index.record(WidgetOrganization(id: "org_active", name: "Active"), isActive: true)

		#expect(OnCallSnapshot.stored(holding: "onc_platform", appGroupIdentifier: harness.suite)?.organizationId == organizationId)
		#expect(OnCallSnapshot.stored(holding: "onc_deleted", appGroupIdentifier: harness.suite) == nil)
	}
}
