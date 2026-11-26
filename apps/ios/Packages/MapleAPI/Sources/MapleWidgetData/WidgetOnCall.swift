import Foundation

/// `GET /v2/widget_summary/oncall`, decoded by hand like the Pages read: the
/// extension does not link the generated client.
public struct WidgetOnCallPayload: Decodable, Sendable, Equatable {
	public var generatedAt: Date
	public var organizationId: String
	/// The person the credential belongs to: "You" on every surface.
	public var userId: String
	public var scheduleWindowEndsAt: Date
	public var schedules: [Schedule]
	public var myShifts: [MyShift]
	/// Absent reads as empty, and every id is then "a teammate".
	public var people: [Person]?

	public struct Shift: Decodable, Sendable, Equatable {
		public var userId: String
		public var startsAt: Date
		public var endsAt: Date
		public var isOverride: Bool?

		private enum CodingKeys: String, CodingKey {
			case userId = "user_id"
			case startsAt = "starts_at"
			case endsAt = "ends_at"
			case isOverride = "is_override"
		}

		/// Nil for a shift that ends before it starts: drawing it would mean guessing when.
		var shift: OnCallSnapshot.Shift? {
			guard endsAt > startsAt else { return nil }
			return .init(userId: userId, start: startsAt, end: endsAt, isOverride: isOverride ?? false)
		}
	}

	public struct Gap: Decodable, Sendable, Equatable {
		public var startsAt: Date
		public var endsAt: Date

		private enum CodingKeys: String, CodingKey {
			case startsAt = "starts_at"
			case endsAt = "ends_at"
		}
	}

	public struct Schedule: Decodable, Sendable, Equatable {
		public var id: String
		public var name: String
		public var rotationSummary: String?
		public var onCallNow: Shift?
		public var next: Shift?
		public var shifts: [Shift]
		public var coverageGaps: [Gap]?

		private enum CodingKeys: String, CodingKey {
			case id
			case name
			case rotationSummary = "rotation_summary"
			case onCallNow = "on_call_now"
			case next
			case shifts
			case coverageGaps = "coverage_gaps"
		}

		var schedule: OnCallSnapshot.Schedule {
			.init(
				id: id,
				name: name,
				rotationSummary: rotationSummary,
				onCallNow: onCallNow?.shift,
				next: next?.shift,
				shifts: shifts.compactMap(\.shift).sorted { $0.start < $1.start },
				gaps: (coverageGaps ?? [])
					.filter { $0.endsAt > $0.startsAt }
					.map { .init(start: $0.startsAt, end: $0.endsAt) }
					.sorted { $0.start < $1.start }
			)
		}
	}

	public struct MyShift: Decodable, Sendable, Equatable {
		public var scheduleId: String
		public var scheduleName: String
		public var startsAt: Date
		public var endsAt: Date
		public var isOverride: Bool?

		private enum CodingKeys: String, CodingKey {
			case scheduleId = "schedule_id"
			case scheduleName = "schedule_name"
			case startsAt = "starts_at"
			case endsAt = "ends_at"
			case isOverride = "is_override"
		}

		var shift: OnCallSnapshot.ViewerShift? {
			guard endsAt > startsAt else { return nil }
			return .init(
				scheduleId: scheduleId, scheduleName: scheduleName, start: startsAt, end: endsAt,
				isOverride: isOverride ?? false
			)
		}
	}

	public struct Person: Decodable, Sendable, Equatable {
		public var userId: String
		public var name: String?

		private enum CodingKeys: String, CodingKey {
			case userId = "user_id"
			case name
		}
	}

	private enum CodingKeys: String, CodingKey {
		case generatedAt = "generated_at"
		case organizationId = "organization_id"
		case userId = "user_id"
		case scheduleWindowEndsAt = "schedule_window_ends_at"
		case schedules
		case myShifts = "my_shifts"
		case people
	}

	public func snapshot(organizationName: String?) -> OnCallSnapshot {
		OnCallSnapshot(
			generatedAt: generatedAt,
			organizationId: organizationId,
			organizationName: organizationName,
			userId: userId,
			windowEnd: scheduleWindowEndsAt,
			schedules: schedules.map(\.schedule),
			myShifts: myShifts.compactMap(\.shift).sorted { $0.start < $1.start },
			people: (people ?? []).compactMap { person in
				guard let name = person.name, !name.isEmpty else { return nil }
				return .init(userId: person.userId, name: name)
			}
		)
	}
}

/// What the On call and Schedule widgets render, as it sits in the App Group
/// between a read and the timelines drawn from it. One read is drawn at many
/// dates, so everything it says takes the date it is said at.
public struct OnCallSnapshot: Codable, Sendable, Equatable {
	public var generatedAt: Date
	public var organizationId: String
	public var organizationName: String?
	/// The owner of the credential the read was signed with.
	public var userId: String
	/// How far `schedules` reaches. Past it the snapshot knows nothing.
	public var windowEnd: Date
	/// In the server's order, by name.
	public var schedules: [Schedule]
	/// The owner's own shifts, earliest first, reaching past the window.
	public var myShifts: [ViewerShift]
	public var people: [Person]

	public struct Shift: Codable, Sendable, Hashable {
		public var userId: String
		public var start: Date
		public var end: Date
		public var isOverride: Bool

		public init(userId: String, start: Date, end: Date, isOverride: Bool = false) {
			self.userId = userId
			self.start = start
			self.end = end
			self.isOverride = isOverride
		}

		public func holds(_ date: Date) -> Bool { start <= date && date < end }
	}

	/// A stretch when nobody is on call.
	public struct Gap: Codable, Sendable, Hashable {
		public var start: Date
		public var end: Date

		public init(start: Date, end: Date) {
			self.start = start
			self.end = end
		}
	}

	public struct Schedule: Codable, Sendable, Hashable, Identifiable {
		/// The public `onc_…` id.
		public var id: String
		public var name: String
		/// "Weekly, hands off Mon 09:00", in the schedule's own zone.
		public var rotationSummary: String?
		/// Carries the shift's real start, which `shifts` may have cut.
		public var onCallNow: Shift?
		/// The shift after the current one, which may start past the window.
		public var next: Shift?
		public var shifts: [Shift]
		public var gaps: [Gap]

		public init(
			id: String, name: String, rotationSummary: String? = nil, onCallNow: Shift? = nil, next: Shift? = nil,
			shifts: [Shift], gaps: [Gap] = []
		) {
			self.id = id
			self.name = name
			self.rotationSummary = rotationSummary
			self.onCallNow = onCallNow
			self.next = next
			self.shifts = shifts
			self.gaps = gaps
		}
	}

	public struct ViewerShift: Codable, Sendable, Hashable {
		public var scheduleId: String
		public var scheduleName: String
		public var start: Date
		public var end: Date
		public var isOverride: Bool

		public init(scheduleId: String, scheduleName: String, start: Date, end: Date, isOverride: Bool = false) {
			self.scheduleId = scheduleId
			self.scheduleName = scheduleName
			self.start = start
			self.end = end
			self.isOverride = isOverride
		}
	}

	public struct Person: Codable, Sendable, Hashable {
		public var userId: String
		public var name: String

		public init(userId: String, name: String) {
			self.userId = userId
			self.name = name
		}
	}

	public init(
		generatedAt: Date, organizationId: String, organizationName: String?, userId: String, windowEnd: Date,
		schedules: [Schedule], myShifts: [ViewerShift], people: [Person]
	) {
		self.generatedAt = generatedAt
		self.organizationId = organizationId
		self.organizationName = organizationName
		self.userId = userId
		self.windowEnd = windowEnd
		self.schedules = schedules
		self.myShifts = myShifts
		self.people = people
	}
}

// MARK: - Names

extension OnCallSnapshot {
	/// The slack between two shifts that still counts as back to back.
	static let seam: TimeInterval = 1

	/// Whether the read still says who is on call at `date`. A snapshot older
	/// than its own window would name whoever held a schedule two weeks ago.
	public func covers(_ date: Date) -> Bool { date < windowEnd }

	public func schedule(id: String) -> Schedule? {
		schedules.first { $0.id == id }
	}

	public func isViewer(_ userId: String) -> Bool { userId == self.userId }

	/// "You", a name, or "A teammate" when `people` has no name for the id.
	/// Mid-sentence the stand-ins are lowercase: "then you".
	public func name(of userId: String, midSentence: Bool = false) -> String {
		if isViewer(userId) { return midSentence ? "you" : "You" }
		if let name = people.first(where: { $0.userId == userId })?.name, !name.isEmpty { return name }
		return midSentence ? "a teammate" : "A teammate"
	}

	/// The label that fits inside a bar of the strip: "You", "Priya", "Teammate".
	public func shortName(of userId: String) -> String {
		if isViewer(userId) { return "You" }
		let first = people.first { $0.userId == userId }?.name.split(separator: " ").first
		return first.map(String.init) ?? "Teammate"
	}

	/// Who is on the other side of a handoff.
	public enum Counterpart: Hashable, Sendable {
		case person(userId: String)
		/// A stretch nobody covers.
		case nobody
		/// Outside what the read covers.
		case unknown
	}

	/// "then Priya Shah", "then nobody". Nil when what follows is unknown.
	public func thenPhrase(_ counterpart: Counterpart) -> String? {
		switch counterpart {
		case .person(let userId): "then \(name(of: userId, midSentence: true))"
		case .nobody: "then nobody"
		case .unknown: nil
		}
	}

	/// "after Marco Ruiz", "after a gap". Nil when what came before is unknown.
	public func afterPhrase(_ counterpart: Counterpart) -> String? {
		switch counterpart {
		case .person(let userId): "after \(name(of: userId, midSentence: true))"
		case .nobody: "after a gap"
		case .unknown: nil
		}
	}
}

// MARK: - One schedule

extension OnCallSnapshot.Schedule {
	/// Every shift the read carries for this schedule, earliest first.
	public var periods: [OnCallSnapshot.Shift] {
		var all = shifts
		for extra in [onCallNow, next].compactMap({ $0 }) where !all.contains(extra) { all.append(extra) }
		return all.sorted { $0.start < $1.start }
	}

	/// Who holds the schedule at `now`. `onCallNow` carries the shift's real
	/// start, so it wins for as long as it still holds.
	public func current(at now: Date) -> OnCallSnapshot.Shift? {
		if let onCallNow, onCallNow.holds(now) { return onCallNow }
		return periods.first { $0.holds(now) }
	}

	/// When the person on `period` stops being on call, and who takes over. Their
	/// own back-to-back shifts (an override of themselves) count as one stretch.
	public func handoff(
		after period: OnCallSnapshot.Shift, windowEnd: Date
	) -> (at: Date, to: OnCallSnapshot.Counterpart) {
		let seam = OnCallSnapshot.seam
		var end = period.end
		for candidate in periods where candidate.start >= end - seam {
			if candidate.start > end + seam { return (end, .nobody) }
			guard candidate.userId == period.userId else { return (end, .person(userId: candidate.userId)) }
			end = max(end, candidate.end)
		}
		// Nothing follows: a gap while the window still has room, otherwise the
		// read simply stops here.
		if end < windowEnd - seam { return (end, .nobody) }
		return (end, .unknown)
	}
}

extension OnCallSnapshot {
	/// Who holds a schedule at one moment.
	public enum Status: Hashable, Sendable {
		case covered(by: Shift, until: Date, then: Counterpart)
		/// Nobody is on call. `next` is the first shift ahead the read knows of.
		case uncovered(next: Shift?)
	}

	public func status(of schedule: Schedule, at now: Date) -> Status {
		guard let current = schedule.current(at: now) else {
			return .uncovered(next: schedule.periods.first { $0.start > now })
		}
		let handoff = schedule.handoff(after: current, windowEnd: windowEnd)
		return .covered(by: current, until: handoff.at, then: handoff.to)
	}
}

// MARK: - The viewer

extension OnCallSnapshot {
	/// Where the owner of the phone stands at one moment.
	public enum ViewerState: Hashable, Sendable {
		case onCall(Current)
		case offCall(Upcoming)
		/// Nothing in the next 60 days.
		case noShifts

		public struct Current: Hashable, Sendable {
			public let scheduleId: String
			public let scheduleName: String
			/// When the viewer stops being on call on this schedule.
			public let until: Date
			public let then: Counterpart
			/// Other schedules the viewer is on call for at the same moment.
			public let otherSchedules: Int
		}

		public struct Upcoming: Hashable, Sendable {
			public let scheduleId: String
			public let scheduleName: String
			public let start: Date
			/// Who holds the schedule until the viewer takes it.
			public let before: Counterpart
		}
	}

	/// The viewer's shifts that have not ended at `now`, earliest first.
	public func viewerShifts(at now: Date) -> [ViewerShift] {
		myShifts.filter { $0.end > now }.sorted { $0.start < $1.start }
	}

	/// When one of the viewer's shifts hands off, and to whom.
	func handoff(after shift: ViewerShift) -> (at: Date, to: Counterpart) {
		guard let schedule = schedule(id: shift.scheduleId) else { return (shift.end, .unknown) }
		let period = Shift(userId: userId, start: shift.start, end: shift.end, isOverride: shift.isOverride)
		return schedule.handoff(after: period, windowEnd: windowEnd)
	}

	/// Who is on call until one of the viewer's shifts starts.
	func predecessor(of shift: ViewerShift) -> Counterpart {
		guard let schedule = schedule(id: shift.scheduleId) else { return .unknown }
		let before = schedule.periods.last {
			$0.start < shift.start && abs($0.end.timeIntervalSince(shift.start)) <= Self.seam
		}
		if let before { return .person(userId: before.userId) }
		// The shift list reaches from the read to the window's end, so silence
		// inside it is a gap and silence outside it is only the edge of the read.
		if shift.start > generatedAt, shift.start <= windowEnd { return .nobody }
		return .unknown
	}

	public func viewerState(at now: Date) -> ViewerState {
		let shifts = viewerShifts(at: now)
		let current = shifts.filter { $0.start <= now }.map { ($0, handoff(after: $0)) }
		// On several schedules at once, the nearest handoff is the next thing to know.
		if let (shift, handoff) = current.min(by: { $0.1.at < $1.1.at }) {
			return .onCall(
				.init(
					scheduleId: shift.scheduleId, scheduleName: shift.scheduleName, until: handoff.at, then: handoff.to,
					otherSchedules: current.count - 1
				)
			)
		}
		if let next = shifts.first {
			return .offCall(
				.init(
					scheduleId: next.scheduleId, scheduleName: next.scheduleName, start: next.start,
					before: predecessor(of: next)
				)
			)
		}
		return .noShifts
	}

	/// The schedule a widget with nothing picked shows: the one the viewer is
	/// on call for, else the first.
	public func defaultSchedule(at now: Date) -> Schedule? {
		if case .onCall(let current) = viewerState(at: now), let schedule = schedule(id: current.scheduleId) {
			return schedule
		}
		return schedules.first
	}
}

// MARK: - The "On call now" table

extension OnCallSnapshot {
	/// One schedule in the table: schedule, who, until.
	public struct Row: Hashable, Sendable, Identifiable {
		public enum Who: Hashable, Sendable {
			case viewer
			case person(userId: String)
			case nobody
		}

		public let id: String
		public let name: String
		public let who: Who
		/// "You", a name, "A teammate", or "Nobody".
		public let whoLabel: String
		/// When the person hands off, or when the gap ends. Nil when nothing
		/// follows inside the window.
		public let until: Date?

		public var isUncovered: Bool { who == .nobody }
	}

	public func row(for schedule: Schedule, at now: Date) -> Row {
		switch status(of: schedule, at: now) {
		case .covered(let period, let until, _):
			Row(
				id: schedule.id,
				name: schedule.name,
				who: isViewer(period.userId) ? .viewer : .person(userId: period.userId),
				whoLabel: name(of: period.userId),
				until: until
			)
		case .uncovered(let next):
			Row(id: schedule.id, name: schedule.name, who: .nobody, whoLabel: "Nobody", until: next?.start)
		}
	}

	/// One row per schedule, in the app's order: the viewer's own first, then the
	/// covered ones, then the ones nobody holds. Inside a group the server's order stands.
	public func tableRows(at now: Date) -> [Row] {
		func rank(_ row: Row) -> Int {
			switch row.who {
			case .viewer: 0
			case .person: 1
			case .nobody: 2
			}
		}
		return schedules.map { row(for: $0, at: now) }
			.enumerated()
			.sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
			.map(\.element)
	}
}

// MARK: - Timeline dates

extension OnCallSnapshot {
	/// How far ahead one timeline is drawn. A reload comes long before it ends.
	public static let timelineHorizon: TimeInterval = 48 * 3600

	/// The moments after `now`, up to `horizon`, when what a widget shows
	/// changes hands: every shift and gap starting or ending, and the read running out.
	public func changeDates(after now: Date, until horizon: Date) -> [Date] {
		var dates: Set<Date> = [windowEnd]
		for schedule in schedules {
			for period in schedule.periods { dates.formUnion([period.start, period.end]) }
			for gap in schedule.gaps { dates.formUnion([gap.start, gap.end]) }
		}
		for shift in myShifts { dates.formUnion([shift.start, shift.end]) }
		return dates.filter { $0 > now && $0 <= horizon }.sorted()
	}

	/// The dates a timeline needs an entry at: `now`, each change, each
	/// midnight, and each hour the coarse "3d 6h" drops by one.
	public func timelineDates(
		from now: Date, horizon: TimeInterval = OnCallSnapshot.timelineHorizon, calendar: Calendar = .current
	) -> [Date] {
		let end = now.addingTimeInterval(horizon)
		var dates = Set(changeDates(after: now, until: end))
		// "in 6 days" counts calendar days, and the strip starts at midnight.
		var day = calendar.startOfDay(for: now)
		while let next = calendar.date(byAdding: .day, value: 1, to: day), next <= end {
			dates.insert(next)
			day = next
		}
		// The wording rounds down, so a label changes the second after a whole
		// hour is left, not on it.
		let justPast: TimeInterval = 1
		for shift in viewerShifts(at: now) where shift.start < end {
			// A day out, both the lead and the time left become clocks that tick on their own.
			dates.insert(shift.start.addingTimeInterval(justPast - 86_400))
			let lastDay = handoff(after: shift).at.addingTimeInterval(justPast - 86_400)
			for tick in stride(from: lastDay, to: max(shift.start, now), by: -3600) where tick <= end {
				dates.insert(tick)
			}
		}
		return [now] + dates.filter { $0 > now && $0 <= end }.sorted()
	}
}

// MARK: - Wording

/// The calendar and locale a time is written in: the device's, except in tests.
public struct WidgetTimeStyle: Sendable {
	public var calendar: Calendar
	public var locale: Locale

	public init(calendar: Calendar = .current, locale: Locale = .current) {
		self.calendar = calendar
		self.locale = locale
	}

	public static var device: WidgetTimeStyle { .init() }

	fileprivate var base: Date.FormatStyle {
		Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
	}
}

// The app says these in `OnCallWording`, `IncidentWording.span` and
// `Format.handoffTime`. This module cannot import them, so the strings are
// reproduced here and pinned by `WidgetOnCallTests`.
extension WidgetTime {
	/// "under 1m", "4m", "1h 5m", "2d 1h".
	public static func span(_ seconds: TimeInterval) -> String {
		let minutes = Int(seconds / 60)
		if minutes < 1 { return "under 1m" }
		if minutes < 60 { return "\(minutes)m" }
		let hours = minutes / 60
		if hours < 24 {
			let rest = minutes % 60
			return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
		}
		let rest = hours % 24
		return rest == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(rest)h"
	}

	/// "3d 6h left", "45m left", "under 1m left".
	public static func remaining(until end: Date, now: Date) -> String {
		"\(span(max(0, end.timeIntervalSince(now)))) left"
	}

	/// "in 12m", "in 5h 30m", "in 6 days". Past a day it counts calendar days:
	/// Thursday's shift is "in 6 days" for the whole of Friday.
	public static func lead(to start: Date, now: Date, calendar: Calendar = .current) -> String {
		let seconds = start.timeIntervalSince(now)
		if seconds <= 0 { return "now" }
		if seconds < 86_400 { return "in \(span(seconds))" }
		let days =
			calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: start)).day
			?? Int(seconds / 86_400)
		return days <= 1 ? "in 1 day" : "in \(days) days"
	}

	/// "09:00", in the locale's own clock.
	public static func clock(_ date: Date, style: WidgetTimeStyle = .device) -> String {
		date.formatted(
			Date.FormatStyle(
				date: .omitted, time: .shortened, locale: style.locale, calendar: style.calendar,
				timeZone: style.calendar.timeZone
			)
		)
	}

	/// "Mon 09:00": a moment inside the coming week.
	public static func weekdayTime(_ date: Date, style: WidgetTimeStyle = .device) -> String {
		"\(date.formatted(style.base.weekday(.abbreviated))) \(clock(date, style: style))"
	}

	/// "Mon 30 Nov 09:00", in the locale's own order.
	public static func dayTime(_ date: Date, style: WidgetTimeStyle = .device) -> String {
		"\(date.formatted(style.base.weekday(.abbreviated).day().month(.abbreviated))) \(clock(date, style: style))"
	}

	/// "Mon 09:00" while a weekday still names one day, then the date.
	/// `compact` drops the far form to "7 Dec", for a column or a large numeral.
	public static func handoffTime(
		_ date: Date, now: Date, compact: Bool = false, style: WidgetTimeStyle = .device
	) -> String {
		if abs(date.timeIntervalSince(now)) < 6 * 86_400 { return weekdayTime(date, style: style) }
		return compact ? date.formatted(style.base.day().month(.abbreviated)) : dayTime(date, style: style)
	}
}

extension OnCallSnapshot {
	/// What the Lock Screen says about the viewer.
	public struct LockScreenText: Hashable, Sendable {
		/// "On call" or "Off call".
		public let lead: String
		/// Beside the lead: the schedule, or "next Thu 09:00".
		public let detail: String
		/// The line under them, when there is one.
		public let second: String?

		/// The one line the inline family has: "On call · until Mon 09:00".
		public let inline: String
	}

	public func lockScreenText(at now: Date, style: WidgetTimeStyle = .device) -> LockScreenText {
		switch viewerState(at: now) {
		case .onCall(let current):
			let until = "until \(WidgetTime.handoffTime(current.until, now: now, style: style))"
			return .init(lead: "On call", detail: current.scheduleName, second: until, inline: "On call · \(until)")
		case .offCall(let next):
			let detail = "next \(WidgetTime.handoffTime(next.start, now: now, compact: true, style: style))"
			return .init(lead: "Off call", detail: detail, second: next.scheduleName, inline: "Off call · \(detail)")
		case .noShifts:
			return .init(lead: "Off call", detail: "no shifts ahead", second: nil, inline: "Off call · no shifts ahead")
		}
	}

	/// The Pages widget's line when nothing is paging: "Platform primary until
	/// Mon 09:00". Nil off call, and once the read no longer reaches `now`.
	public func pagesShiftLine(at now: Date, style: WidgetTimeStyle = .device) -> String? {
		guard covers(now), case .onCall(let current) = viewerState(at: now) else { return nil }
		return "\(current.scheduleName) until \(WidgetTime.handoffTime(current.until, now: now, style: style))"
	}

	/// The Schedule widget's line under its title: who, then "until Mon 09:00 ·
	/// then Priya Shah".
	public struct ScheduleLine: Hashable, Sendable {
		public let who: Row.Who
		public let whoLabel: String
		public let detail: String
	}

	public func scheduleLine(for schedule: Schedule, at now: Date, style: WidgetTimeStyle = .device) -> ScheduleLine {
		switch status(of: schedule, at: now) {
		case .covered(let period, let until, let then):
			let parts = ["until \(WidgetTime.handoffTime(until, now: now, style: style))", thenPhrase(then)]
			return ScheduleLine(
				who: isViewer(period.userId) ? .viewer : .person(userId: period.userId),
				whoLabel: name(of: period.userId),
				detail: parts.compactMap { $0 }.joined(separator: " · ")
			)
		case .uncovered(let next):
			let detail = next.map {
				"until \(WidgetTime.handoffTime($0.start, now: now, style: style)) · then \(name(of: $0.userId, midSentence: true))"
			}
			return ScheduleLine(who: .nobody, whoLabel: "Nobody", detail: detail ?? "no shift ahead")
		}
	}
}

// MARK: - The seven day strip

extension OnCallSnapshot {
	/// One schedule over seven calendar days from today's midnight, as
	/// fractions of that window: one lane per person and what nobody covers.
	public struct Strip: Hashable, Sendable {
		public static let dayCount = 7

		/// A stretch of the window, 0 at its start and 1 at its end.
		public struct Segment: Hashable, Sendable {
			public let start: Double
			public let end: Double
			public let isOverride: Bool

			public init(start: Double, end: Double, isOverride: Bool = false) {
				self.start = start
				self.end = end
				self.isOverride = isOverride
			}

			public var length: Double { end - start }
		}

		public struct Lane: Hashable, Sendable, Identifiable {
			public let userId: String
			/// "You", or a first name: what fits inside a bar.
			public let label: String
			public let isViewer: Bool
			public let segments: [Segment]

			public var id: String { userId }
			/// The fraction of the window this person covers.
			public var share: Double { segments.reduce(0) { $0 + $1.length } }
		}

		public struct Day: Hashable, Sendable {
			/// The weekday's narrow letter. Today's comes first.
			public let letter: String
			public let start: Double
			public let end: Double
		}

		public let start: Date
		public let end: Date
		public let days: [Day]
		/// In order of first appearance, so whoever holds the window's start leads.
		public let lanes: [Lane]
		public let gaps: [Segment]
		/// "Dana Kim covers Wed 10:00 to 22:00": the first override still ahead
		/// or under way inside the window.
		public let overrideLine: String?
	}

	public func strip(for schedule: Schedule, at now: Date, style: WidgetTimeStyle = .device) -> Strip {
		let calendar = style.calendar
		func day(_ offset: Int, after date: Date) -> Date {
			calendar.date(byAdding: .day, value: offset, to: date) ?? date.addingTimeInterval(Double(offset) * 86_400)
		}
		let start = calendar.startOfDay(for: now)
		let end = day(Strip.dayCount, after: start)
		let length = end.timeIntervalSince(start)
		let seam = Self.seam / length
		func fraction(_ date: Date) -> Double { min(1, max(0, date.timeIntervalSince(start) / length)) }

		let periods = schedule.periods.filter { $0.end > start && $0.start < end }
		var order: [String] = []
		var segments: [String: [Strip.Segment]] = [:]
		for period in periods {
			let segment = Strip.Segment(start: fraction(period.start), end: fraction(period.end), isOverride: period.isOverride)
			guard segment.length > 0 else { continue }
			var lane = segments[period.userId] ?? []
			if lane.isEmpty { order.append(period.userId) }
			// Back-to-back stretches of one kind draw as one bar.
			if let last = lane.last, last.isOverride == segment.isOverride, segment.start <= last.end + seam {
				lane[lane.count - 1] = .init(start: last.start, end: max(last.end, segment.end), isOverride: last.isOverride)
			} else {
				lane.append(segment)
			}
			segments[period.userId] = lane
		}

		let gaps = schedule.gaps
			.map { Strip.Segment(start: fraction($0.start), end: fraction($0.end)) }
			.filter { $0.length > 0 }

		return Strip(
			start: start,
			end: end,
			days: (0..<Strip.dayCount).map { offset in
				let from = day(offset, after: start)
				return .init(
					letter: from.formatted(style.base.weekday(.narrow)),
					start: fraction(from),
					end: fraction(day(offset + 1, after: start))
				)
			},
			lanes: order.map { userId in
				.init(userId: userId, label: shortName(of: userId), isViewer: isViewer(userId), segments: segments[userId] ?? [])
			},
			gaps: gaps,
			overrideLine: overrideLine(in: periods, at: now, style: style)
		)
	}

	private func overrideLine(in periods: [Shift], at now: Date, style: WidgetTimeStyle) -> String? {
		guard let override = periods.first(where: { $0.isOverride && $0.end > now }) else { return nil }
		let who = "\(name(of: override.userId)) \(isViewer(override.userId) ? "cover" : "covers")"
		if override.start <= now {
			return "\(who) until \(WidgetTime.handoffTime(override.end, now: now, style: style))"
		}
		// An override that ends the day it starts needs its day said once.
		let until =
			style.calendar.isDate(override.start, inSameDayAs: override.end)
			? WidgetTime.clock(override.end, style: style)
			: WidgetTime.handoffTime(override.end, now: now, style: style)
		return "\(who) \(WidgetTime.handoffTime(override.start, now: now, style: style)) to \(until)"
	}
}

// MARK: - Storage

extension WidgetSnapshotStore where Value == OnCallSnapshot {
	/// Per organization, never per environment: a rotation is people, whatever
	/// environment their alerts watch.
	public static func onCall(
		organizationId: String,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> WidgetSnapshotStore<OnCallSnapshot> {
		.init(key: "oncall.snapshot.v1.\(organizationId)", appGroupIdentifier: appGroupIdentifier)
	}
}

extension OnCallSnapshot {
	/// The stored snapshot holding a schedule: the active organization's first,
	/// then any other this phone knows. A Schedule widget keeps its rotation
	/// when the app moves to another organization.
	public static func stored(
		holding scheduleId: String, appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> OnCallSnapshot? {
		WidgetOrganizationIndex(appGroupIdentifier: appGroupIdentifier).load().lazy
			.compactMap {
				WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: $0.id, appGroupIdentifier: appGroupIdentifier).load()
			}
			.first { $0.schedule(id: scheduleId) != nil }
	}
}

/// How the last on-call read ended, from a widget or the app, and how many
/// have failed in a row. Read by the app onto its widget span.
public struct OnCallReadRecord: Codable, Sendable, Equatable {
	public enum Outcome: String, Codable, Sendable {
		case fetched
		case noCredential = "no_credential"
		case needsApp = "needs_app"
		case failed
	}

	public var outcome: Outcome
	public var at: Date
	public var consecutiveFailures: Int

	public init(outcome: Outcome, at: Date, consecutiveFailures: Int) {
		self.outcome = outcome
		self.at = at
		self.consecutiveFailures = consecutiveFailures
	}
}

extension WidgetSnapshotStore where Value == OnCallReadRecord {
	public static func onCallRead(
		organizationId: String,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> WidgetSnapshotStore<OnCallReadRecord> {
		.init(key: "oncall.read.v1.\(organizationId)", appGroupIdentifier: appGroupIdentifier)
	}
}

// MARK: - The read

/// The on-call widgets' one request, signed with the device credential the app
/// registered. The app uses it too, so both write one shape into the App Group.
/// Failing changes nothing: the widgets keep their last snapshot.
public actor WidgetOnCallClient {
	public static let shared = WidgetOnCallClient()

	private let credentials: WidgetCredentialStore
	private let keys: any DeviceKeyStoring
	private let tokens: DeviceTokenClient
	private let session: any WidgetHTTPTransport
	/// Where snapshots are written. Only tests point it elsewhere.
	private let appGroupIdentifier: String
	private let fetchStates: WidgetFetchStateStore
	/// Two widget kinds draw from one read, and WidgetKit wakes them together.
	private var inFlight: [String: Task<Refresh, Never>] = [:]

	public init(
		credentials: WidgetCredentialStore = WidgetCredentialStore(),
		keys: any DeviceKeyStoring = KeychainDeviceKeyStore(),
		tokens: DeviceTokenClient? = nil,
		session: (any WidgetHTTPTransport)? = nil,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) {
		self.credentials = credentials
		self.keys = keys
		self.appGroupIdentifier = appGroupIdentifier
		self.fetchStates = WidgetFetchStateStore(appGroupIdentifier: appGroupIdentifier)
		let session = session ?? WidgetSummaryFetcher.makeSession()
		self.session = session
		self.tokens = tokens ?? DeviceTokenClient(transport: session, store: credentials)
	}

	public enum Refresh: Sendable, Equatable {
		case fetched(OnCallSnapshot)
		/// The app has not registered a key for this organization yet.
		case noCredential
		/// The credential expired or was refused. Only the app can replace it.
		case needsApp
		case failed
	}

	/// Read who is on call and when the credential's owner is, and store it.
	/// A snapshot read less than `freshFor` ago is handed back unread: a second
	/// widget woken beside the first has nothing new to learn.
	public func refresh(
		organizationId: String, organizationName: String?, freshFor: TimeInterval = 0, now: Date = Date()
	) async -> Refresh {
		if let fresh = freshSnapshot(organizationId, within: freshFor, now: now) { return .fetched(fresh) }
		if let running = inFlight[organizationId] { return await running.value }
		let task = Task { await readAndRecord(organizationId: organizationId, organizationName: organizationName, now: now) }
		inFlight[organizationId] = task
		let answer = await task.value
		inFlight[organizationId] = nil
		return answer
	}

	private func freshSnapshot(_ organizationId: String, within freshFor: TimeInterval, now: Date) -> OnCallSnapshot? {
		guard freshFor > 0, let last = reads(organizationId).load(), last.outcome == .fetched,
			(0..<freshFor).contains(now.timeIntervalSince(last.at))
		else { return nil }
		return store(organizationId).load()
	}

	private func readAndRecord(organizationId: String, organizationName: String?, now: Date) async -> Refresh {
		let answer = await read(organizationId: organizationId, organizationName: organizationName, now: now)
		let outcome: OnCallReadRecord.Outcome =
			switch answer {
			case .fetched: .fetched
			case .noCredential: .noCredential
			case .needsApp: .needsApp
			case .failed: .failed
			}
		let reads = reads(organizationId)
		let failures = outcome == .fetched ? 0 : (reads.load()?.consecutiveFailures ?? 0) + 1
		reads.save(OnCallReadRecord(outcome: outcome, at: now, consecutiveFailures: failures))
		return answer
	}

	private func read(organizationId: String, organizationName: String?, now: Date) async -> Refresh {
		guard let device = credentials.loadDevice(organizationId: organizationId) else { return .noCredential }
		// A record without its key (a restored backup) signs nothing.
		guard !device.isExpired(at: now), let key = keys.load(organizationId: organizationId),
			key.thumbprint == device.jkt
		else { return .needsApp }
		// The server refused this credential and the app has not replaced it yet:
		// every request would be refused, so none is sent.
		if fetchStates.load(organizationId: organizationId).isCredentialRejected { return .needsApp }

		let url = device.apiBaseURL.appendingPathComponent("v2/widget_summary/oncall")
		let sent = await DeviceRequest.send(
			{
				var request = URLRequest(url: url, timeoutInterval: WidgetSummaryFetcher.deadline)
				request.httpMethod = "GET"
				request.setValue("application/json", forHTTPHeaderField: "Accept")
				return request
			},
			credential: device, key: key, session: session, tokens: tokens, now: now
		)
		guard case .response(let response) = sent else {
			// Revoked, say by a role change. Recorded where the app looks before
			// deciding a key is still good, so its next foreground registers a new one.
			guard case .failure(.unauthorized) = sent else { return .failed }
			fetchStates.recordCredentialRejection(organizationId: organizationId, at: now)
			return .needsApp
		}
		switch response.status {
		case 200:
			// A disagreement would put one organization's rotations under another's name.
			guard let payload = try? WidgetJSON.decoder.decode(WidgetOnCallPayload.self, from: response.data),
				payload.organizationId == organizationId
			else { return .failed }
			let snapshot = payload.snapshot(organizationName: organizationName)
			store(organizationId).save(snapshot)
			return .fetched(snapshot)
		case 401, 403:
			return .needsApp
		default:
			return .failed
		}
	}

	private nonisolated func store(_ organizationId: String) -> WidgetSnapshotStore<OnCallSnapshot> {
		.onCall(organizationId: organizationId, appGroupIdentifier: appGroupIdentifier)
	}

	private nonisolated func reads(_ organizationId: String) -> WidgetSnapshotStore<OnCallReadRecord> {
		.onCallRead(organizationId: organizationId, appGroupIdentifier: appGroupIdentifier)
	}
}

// MARK: - Sample

extension OnCallSnapshot {
	/// The widget gallery and the redacted placeholder: on call for three more
	/// days, one teammate covering an evening, one schedule with nobody on it.
	public static var sample: OnCallSnapshot {
		let now = Date()
		func hours(_ count: Double) -> Date { now.addingTimeInterval(count * 3600) }
		let me = "user_sample"
		let mine = Shift(userId: me, start: hours(-90), end: hours(78.5))
		let platform = [
			mine,
			Shift(userId: "user_priya", start: hours(78.5), end: hours(127.5)),
			Shift(userId: "user_dana", start: hours(127.5), end: hours(139.5), isOverride: true),
			Shift(userId: "user_priya", start: hours(139.5), end: hours(246.5)),
		]
		let payments = [
			Shift(userId: "user_dana", start: hours(-130), end: hours(38)),
			Shift(userId: "user_marco", start: hours(38), end: hours(206)),
		]
		let pipeline = [Shift(userId: "user_priya", start: hours(54), end: hours(126))]
		return OnCallSnapshot(
			generatedAt: now,
			organizationId: "org_sample",
			organizationName: "acme-prod",
			userId: me,
			windowEnd: hours(14 * 24),
			schedules: [
				Schedule(
					id: "onc_pipeline", name: "Data pipeline", next: pipeline[0], shifts: pipeline,
					gaps: [Gap(start: now, end: hours(54))]
				),
				Schedule(
					id: "onc_payments", name: "Payments primary", rotationSummary: "Weekly, hands off Fri 18:00",
					onCallNow: payments[0], next: payments[1], shifts: payments
				),
				Schedule(
					id: "onc_platform", name: "Platform primary", rotationSummary: "Weekly, hands off Mon 09:00",
					onCallNow: mine, next: platform[1], shifts: platform
				),
			],
			myShifts: [ViewerShift(scheduleId: "onc_platform", scheduleName: "Platform primary", start: mine.start, end: mine.end)],
			people: [
				Person(userId: me, name: "Alex Chen"),
				Person(userId: "user_priya", name: "Priya Shah"),
				Person(userId: "user_dana", name: "Dana Kim"),
				Person(userId: "user_marco", name: "Marco Ruiz"),
			]
		)
	}
}
