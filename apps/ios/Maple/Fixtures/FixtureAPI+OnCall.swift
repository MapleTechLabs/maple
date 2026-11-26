import Foundation
import MapleAPI

/// The fixture organization's on-call world: four schedules, the fixture user
/// on call for one of them now, and one that a single person holds with no
/// handoff ahead. Every date is built from the clock and the device's calendar,
/// so handoffs read 09:00 here and the screens never go stale.
extension FixtureAPI {
	private static let priya = "user_priya"
	private static let dana = "user_dana"
	private static let marco = "user_marco"

	func onCallOverview() async throws -> OnCallOverview {
		try await pause()
		let calendar = Calendar.current
		let me = FixtureSession.userId
		let windowEnd = now.addingTimeInterval(14 * 86_400)

		/// The next time the clock reads `hour` on `weekday` (1 is Sunday).
		func next(_ weekday: Int, _ hour: Int) -> Date {
			calendar.nextDate(
				after: now, matching: DateComponents(hour: hour, minute: 0, second: 0, weekday: weekday),
				matchingPolicy: .nextTime
			) ?? now.addingTimeInterval(7 * 86_400)
		}
		// Calendar days, so a handoff stays at the same clock time across a DST change.
		func days(_ count: Int, after date: Date) -> Date {
			calendar.date(byAdding: .day, value: count, to: date) ?? date.addingTimeInterval(Double(count) * 86_400)
		}
		func format(_ date: Date) -> String { ResolvedTimeWindow.format(date) }
		func shift(
			_ userId: String, _ start: Date, _ end: Date, override: Bool = false, continues: Bool = false
		) -> OnCallShift {
			OnCallShift(
				continues: continues, endsAt: format(end), isOverride: override, startsAt: format(start), userId: userId
			)
		}
		/// As the server lists them: only what reaches into the window, cut at its
		/// end, and marked as continuing where the cut is not a handoff.
		func inWindow(_ shifts: [(String, Date, Date, Bool)]) -> [OnCallShift] {
			shifts.filter { $0.2 > now && $0.1 < windowEnd }.map {
				shift($0.0, $0.1, min($0.2, windowEnd), override: $0.3, continues: $0.2 > windowEnd)
			}
		}

		// Platform primary: weekly on Monday 09:00. The fixture user, then Priya
		// with Dana covering her Saturday, then Marco.
		let monday = next(2, 9)
		let overrideStart = days(5, after: monday).addingTimeInterval(3600)
		let overrideEnd = overrideStart.addingTimeInterval(10 * 3600)
		let platformNow = shift(me, days(-7, after: monday), monday)
		let platform = inWindow([
			(me, days(-7, after: monday), monday, false),
			(Self.priya, monday, overrideStart, false),
			(Self.dana, overrideStart, overrideEnd, true),
			(Self.priya, overrideEnd, days(7, after: monday), false),
			(Self.marco, days(7, after: monday), days(14, after: monday), false),
		])

		// Payments primary: a rotation of one. Dana holds it past both windows, so
		// her stretch is cut at 60 days, her shift at 14, and nothing follows either.
		let friday = next(6, 18)
		let danaSince = days(-7, after: friday)
		let paymentsPrimaryNow = shift(Self.dana, danaSince, now.addingTimeInterval(60 * 86_400), continues: true)
		let paymentsPrimary = [shift(Self.dana, danaSince, windowEnd, continues: true)]

		// Payments secondary: Marco now, the fixture user in six days at 09:00.
		let today = calendar.startOfDay(for: now)
		let mine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: days(6, after: today)) ?? days(6, after: today)
		let paymentsSecondary = inWindow([
			(Self.marco, days(-7, after: mine), mine, false),
			(me, mine, days(7, after: mine), false),
			(Self.priya, days(7, after: mine), days(14, after: mine), false),
		])
		let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
		let handoffDay = weekdays[(calendar.component(.weekday, from: mine) - 1) % 7]

		// Data pipeline: nobody until Saturday 08:00, and a day uncovered a week on.
		let saturday = next(7, 8)
		let pipeline = inWindow([
			(Self.priya, saturday, days(3, after: saturday), false),
			(Self.marco, days(3, after: saturday), days(6, after: saturday), false),
			(Self.priya, days(7, after: saturday), days(14, after: saturday), false),
		])
		let pipelineGaps = [(now, saturday), (days(6, after: saturday), days(7, after: saturday))]
			.filter { $0.0 < windowEnd }
			.map { OnCallGap(endsAt: format(min($0.1, windowEnd)), startsAt: format($0.0)) }

		func schedule(
			_ id: String, _ name: String, _ summary: String, zone: String = "Europe/Berlin", current: OnCallShift?,
			shifts: [OnCallShift], gaps: [OnCallGap] = []
		) -> OnCallSchedule {
			OnCallSchedule(
				coverageGaps: gaps,
				id: id,
				name: name,
				// The shift after the current one, or the first ahead when nobody is on call.
				next: current == nil ? shifts.first : shifts.dropFirst().first,
				onCallNow: current,
				rotationSummary: summary,
				shifts: shifts,
				timeZone: zone
			)
		}
		func myShift(_ id: String, _ name: String, _ start: Date, _ end: Date) -> OnCallMyShift {
			OnCallMyShift(
				continues: false, endsAt: format(end), isOverride: false, scheduleId: id, scheduleName: name,
				startsAt: format(start)
			)
		}

		return OnCallOverview(
			generatedAt: format(now),
			myShifts: [
				myShift("onc_platform_primary", "Platform primary", days(-7, after: monday), monday),
				myShift("onc_payments_secondary", "Payments secondary", mine, days(7, after: mine)),
				myShift("onc_platform_primary", "Platform primary", days(14, after: monday), days(21, after: monday)),
			],
			object: .oncallOverview,
			organizationId: FixtureSession.organizationId,
			people: [
				OnCallPerson(name: "Alex Chen", userId: me),
				OnCallPerson(name: "Priya Shah", userId: Self.priya),
				OnCallPerson(name: "Dana Kim", userId: Self.dana),
				OnCallPerson(name: "Marco Ruiz", userId: Self.marco),
			],
			scheduleWindowEndsAt: format(windowEnd),
			// By name, as the server orders them.
			schedules: [
				schedule(
					"onc_data_pipeline", "Data pipeline", "2 layers", zone: "America/New_York", current: nil, shifts: pipeline,
					gaps: pipelineGaps
				),
				schedule(
					"onc_payments_primary", "Payments primary", "Weekly, hands off Fri 18:00", current: paymentsPrimaryNow,
					shifts: paymentsPrimary
				),
				schedule(
					"onc_payments_secondary", "Payments secondary", "Weekly, hands off \(handoffDay) 09:00",
					current: paymentsSecondary.first, shifts: paymentsSecondary
				),
				schedule(
					"onc_platform_primary", "Platform primary", "Weekly, hands off Mon 09:00", current: platformNow,
					shifts: platform
				),
			],
			userId: me
		)
	}
}
