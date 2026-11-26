import Foundation

// What the on-call screens say about one overview document. Kept here, in the
// package, because the Overview card, the On call screen and the Schedule
// screen must agree about the same shift, and this is the part with tests.

/// A shift with its bounds parsed. One whose bounds will not parse is dropped:
/// drawing it would mean guessing when.
public struct OnCallPeriod: Hashable, Sendable {
	public let userId: String
	public let start: Date
	public let end: Date
	public let isOverride: Bool
	/// The person is still on call at `end`: a window stopped there and nobody
	/// took over. Such an end is never a handoff.
	public let continues: Bool

	public init(userId: String, start: Date, end: Date, isOverride: Bool, continues: Bool) {
		self.userId = userId
		self.start = start
		self.end = end
		self.isOverride = isOverride
		self.continues = continues
	}

	public func holds(_ date: Date) -> Bool { start <= date && date < end }
}

extension OnCallShift {
	public var period: OnCallPeriod? {
		guard let start = ResolvedTimeWindow.parse(startsAt), let end = ResolvedTimeWindow.parse(endsAt), end > start
		else { return nil }
		return OnCallPeriod(userId: userId, start: start, end: end, isOverride: isOverride, continues: continues)
	}
}

/// How a stretch on call ends.
public enum OnCallEnd: Hashable, Sendable {
	/// Someone else takes over.
	case handoff(at: Date, to: String)
	/// Coverage stops and a gap follows.
	case gap(at: Date)
	/// It ends further ahead than the overview names who follows.
	case unknown(at: Date)
	/// Still on call where the overview stops. That cut is not an end, so this
	/// carries no date to print or count down to.
	case continues

	/// When the person stops being on call. Nil while no end is scheduled.
	public var date: Date? {
		switch self {
		case .handoff(let at, _), .gap(let at), .unknown(let at): at
		case .continues: nil
		}
	}
}

/// Who holds a schedule at one moment.
public enum OnCallScheduleStatus: Hashable, Sendable {
	case covered(by: OnCallPeriod, end: OnCallEnd)
	/// Nobody is on call. `next` is the first shift ahead, when one starts inside the window.
	case uncovered(next: OnCallPeriod?)
}

extension OnCallSchedule {
	/// The slack between two shifts that still counts as back to back.
	static let seam: TimeInterval = 1

	/// The effective shifts, earliest first.
	public var periods: [OnCallPeriod] {
		shifts.compactMap(\.period).sorted { $0.start < $1.start }
	}

	/// `shifts` with `next` folded in. The server takes `next` from `shifts`; one
	/// that ever came from past the cut would still count.
	private var periodsAhead: [OnCallPeriod] {
		(periods + [next?.period].compactMap { $0 }).sorted { $0.start < $1.start }
	}

	/// Who holds the schedule at `now`. `on_call_now` is the whole stretch, with
	/// its real start and an end past the window, so it wins while it still holds.
	public func current(now: Date) -> OnCallPeriod? {
		if let period = onCallNow?.period, period.holds(now) { return period }
		return periods.first { $0.holds(now) }
	}

	/// How the person on `period` stops being on call. Their own back-to-back
	/// shifts (an override of themselves) count as one stretch.
	public func end(of period: OnCallPeriod, windowEnd: Date?) -> OnCallEnd {
		var end = period.end
		var continues = period.continues
		// A stretch that continues has nothing after it: the server cut it there.
		for candidate in periodsAhead where !continues && candidate.start >= end - Self.seam {
			if candidate.start > end + Self.seam { return .gap(at: end) }
			guard candidate.userId == period.userId else { return .handoff(at: end, to: candidate.userId) }
			if candidate.end > end {
				end = candidate.end
				continues = candidate.continues
			}
		}
		if continues { return .continues }
		// Nothing follows: a gap while the window still has room, otherwise the
		// overview does not reach far enough to say who does.
		if let windowEnd, end < windowEnd - Self.seam { return .gap(at: end) }
		return .unknown(at: end)
	}

	public func status(now: Date, windowEnd: Date?) -> OnCallScheduleStatus {
		guard let current = current(now: now) else {
			return .uncovered(next: periodsAhead.first { $0.start > now })
		}
		return .covered(by: current, end: end(of: current, windowEnd: windowEnd))
	}
}

// MARK: - Names

extension OnCallOverview {
	public var windowEnd: Date? { ResolvedTimeWindow.parse(scheduleWindowEndsAt) }

	public func schedule(id: String) -> OnCallSchedule? {
		schedules.first { $0.id == id }
	}

	/// Whether a shift's user is the person holding the phone.
	public func isViewer(_ userId: String) -> Bool { userId == self.userId }

	/// "You", a name, or "A teammate" when the directory has no name for them.
	/// Mid-sentence the stand-ins are lowercase: "hands off to you".
	public func name(of userId: String, midSentence: Bool = false) -> String {
		if isViewer(userId) { return midSentence ? "you" : "You" }
		if let name = people.first(where: { $0.userId == userId })?.name, !name.isEmpty { return name }
		return midSentence ? "a teammate" : "A teammate"
	}

	/// "hands off to Priya Shah", "nobody takes over". Nil when what follows is
	/// unknown, and when nothing does: the person stays on call.
	public func handsOffPhrase(_ end: OnCallEnd) -> String? {
		switch end {
		case .handoff(_, let userId): "hands off to \(name(of: userId, midSentence: true))"
		case .gap: "nobody takes over"
		case .unknown, .continues: nil
		}
	}

	/// "then Priya Shah", "then nobody". Nil in the same two cases.
	public func thenPhrase(_ end: OnCallEnd) -> String? {
		switch end {
		case .handoff(_, let userId): "then \(name(of: userId, midSentence: true))"
		case .gap: "then nobody"
		case .unknown, .continues: nil
		}
	}

	/// Whether this overview was read for this person in this organization. One
	/// handed over from another account or organization must not be painted.
	public func belongs(toUser userId: String?, organization organizationId: String?) -> Bool {
		guard let userId, let organizationId else { return false }
		return self.userId == userId && self.organizationId == organizationId
	}
}

// MARK: - The viewer

/// One of the viewer's own shifts, bounds parsed.
public struct OnCallViewerShift: Hashable, Sendable, Identifiable {
	public let scheduleId: String
	public let scheduleName: String
	public let start: Date
	/// Where the shift ends, or where the 60 day window cut it when `continues`.
	public let end: Date
	public let isOverride: Bool
	/// The shift runs past the window, so `end` is not a date to show as its end.
	public let continues: Bool

	public init(
		scheduleId: String, scheduleName: String, start: Date, end: Date, isOverride: Bool, continues: Bool
	) {
		self.scheduleId = scheduleId
		self.scheduleName = scheduleName
		self.start = start
		self.end = end
		self.isOverride = isOverride
		self.continues = continues
	}

	public var id: String { "\(scheduleId)|\(start.timeIntervalSince1970)" }

	public func isCurrent(now: Date) -> Bool { start <= now && now < end }
}

/// Where the person holding the phone stands: on call, off call with a shift
/// ahead, or in no rotation at all.
public enum OnCallViewerState: Hashable, Sendable {
	case onCall(Current)
	case offCall(next: OnCallViewerShift)
	case noShifts

	public struct Current: Hashable, Sendable {
		public let shift: OnCallViewerShift
		/// How the viewer stops being on call on this schedule.
		public let end: OnCallEnd
		/// Other schedules the viewer is on call for at the same moment.
		public let otherSchedules: Int

		public init(shift: OnCallViewerShift, end: OnCallEnd, otherSchedules: Int = 0) {
			self.shift = shift
			self.end = end
			self.otherSchedules = otherSchedules
		}

		/// How much of the shift is behind the viewer, 0 to 1. Nil with no end
		/// scheduled: there is nothing to measure toward.
		public func progress(now: Date) -> Double? {
			guard let until = end.date else { return nil }
			let length = until.timeIntervalSince(shift.start)
			guard length > 0 else { return 1 }
			return min(1, max(0, now.timeIntervalSince(shift.start) / length))
		}
	}

	public var isOnCall: Bool {
		if case .onCall = self { return true }
		return false
	}

	/// The line under the On call title: "You are on call" and, muted after it,
	/// "· 3d 6h left on Platform primary", or "· no handoff scheduled on Platform
	/// primary" for a shift with no end in sight.
	public func headline(now: Date, calendar: Calendar = .current) -> (lead: String, detail: String) {
		switch self {
		case .onCall(let current):
			let others =
				switch current.otherSchedules {
				case 0: ""
				case 1: " and 1 more schedule"
				default: " and \(current.otherSchedules) more schedules"
				}
			let timing =
				current.end.date.map { OnCallWording.remaining(until: $0, now: now) } ?? OnCallWording.noHandoffScheduled
			return ("You are on call", "· \(timing) on \(current.shift.scheduleName)\(others)")
		case .offCall(let next):
			return (
				"You are off call",
				"· next shift \(OnCallWording.lead(to: next.start, now: now, calendar: calendar)) on \(next.scheduleName)"
			)
		case .noShifts:
			return ("You are off call", "· no shifts in the next 60 days")
		}
	}
}

extension OnCallOverview {
	/// The viewer's shifts that have not ended, earliest first.
	public func viewerShifts(now: Date = Date()) -> [OnCallViewerShift] {
		myShifts.compactMap { shift -> OnCallViewerShift? in
			guard let start = ResolvedTimeWindow.parse(shift.startsAt), let end = ResolvedTimeWindow.parse(shift.endsAt),
				end > start, end > now
			else { return nil }
			return OnCallViewerShift(
				scheduleId: shift.scheduleId, scheduleName: shift.scheduleName, start: start, end: end,
				isOverride: shift.isOverride, continues: shift.continues
			)
		}
		.sorted { $0.start < $1.start }
	}

	/// How one of the viewer's shifts ends. One the 60 day window cut has no
	/// end: the schedule is only asked who follows a real one.
	public func end(of shift: OnCallViewerShift) -> OnCallEnd {
		if shift.continues { return .continues }
		guard let schedule = schedule(id: shift.scheduleId) else { return .unknown(at: shift.end) }
		let period = OnCallPeriod(
			userId: userId, start: shift.start, end: shift.end, isOverride: shift.isOverride, continues: false
		)
		return schedule.end(of: period, windowEnd: windowEnd)
	}

	public func viewerState(now: Date = Date()) -> OnCallViewerState {
		let shifts = viewerShifts(now: now)
		let current = shifts.filter { $0.isCurrent(now: now) }.map { ($0, end(of: $0)) }
		// On several schedules at once, the nearest end is the next thing to know.
		// A shift with none scheduled leads only when none of them has one.
		if let (shift, end) = current.min(by: { ($0.1.date ?? .distantFuture) < ($1.1.date ?? .distantFuture) }) {
			return .onCall(.init(shift: shift, end: end, otherSchedules: current.count - 1))
		}
		if let next = shifts.first { return .offCall(next: next) }
		return .noShifts
	}
}

// MARK: - Wording

public enum OnCallWording {
	// The words for someone still on call where the overview stops. One set, so
	// the card, the header, the tables and the Schedule screen cannot disagree.

	/// Where "until Mon 09:00 · hands off to Priya Shah" would be.
	public static let noHandoffScheduled = "no handoff scheduled"
	/// The "On call now" table's Until column.
	public static let noHandoff = "No handoff"
	/// Where one of the viewer's shifts would give its end date.
	public static let noEndScheduled = "no end scheduled"

	/// The Schedule screen's line. Its window is all a schedule vouches for.
	public static func noHandoff(inNext days: Int) -> String {
		"No handoff in the next \(days) days"
	}

	/// "3d 6h left", "45m left", "under 1m left".
	public static func remaining(until end: Date, now: Date) -> String {
		"\(IncidentWording.span(max(0, end.timeIntervalSince(now)))) left"
	}

	/// "in 12m", "in 5h 30m", "in 6 days". Past a day it counts calendar days, as
	/// people do: Thursday's shift is "in 6 days" for the whole of Friday.
	public static func lead(to start: Date, now: Date, calendar: Calendar = .current) -> String {
		let seconds = start.timeIntervalSince(now)
		if seconds <= 0 { return "now" }
		if seconds < 86_400 { return "in \(IncidentWording.span(seconds))" }
		let days =
			calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: start)).day
			?? Int(seconds / 86_400)
		return days <= 1 ? "in 1 day" : "in \(days) days"
	}
}

// MARK: - Schedule rows

/// One schedule in the "On call now" table: schedule, who, until.
public struct OnCallScheduleRow: Hashable, Sendable, Identifiable {
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
	/// When the person stops being on call, or when the gap ends. Nil when no
	/// shift starts inside the window, and when the person simply stays on call.
	public let until: Date?
	/// Whoever is on call stays on call: the Until column says so, not a date.
	public let hasNoHandoff: Bool

	public var isUncovered: Bool { who == .nobody }
}

extension OnCallOverview {
	public func scheduleRow(for schedule: OnCallSchedule, now: Date = Date()) -> OnCallScheduleRow {
		switch schedule.status(now: now, windowEnd: windowEnd) {
		case .covered(let period, let end):
			OnCallScheduleRow(
				id: schedule.id,
				name: schedule.name,
				who: isViewer(period.userId) ? .viewer : .person(userId: period.userId),
				whoLabel: name(of: period.userId),
				until: end.date,
				hasNoHandoff: end == .continues
			)
		case .uncovered(let next):
			OnCallScheduleRow(
				id: schedule.id, name: schedule.name, who: .nobody, whoLabel: "Nobody", until: next?.start,
				hasNoHandoff: false
			)
		}
	}

	/// One row per schedule: the viewer's own first, then the covered ones, then
	/// the ones nobody holds. Inside each group the server's order (by name) stands.
	public func scheduleRows(now: Date = Date()) -> [OnCallScheduleRow] {
		func rank(_ row: OnCallScheduleRow) -> Int {
			switch row.who {
			case .viewer: 0
			case .person: 1
			case .nobody: 2
			}
		}
		return schedules.map { scheduleRow(for: $0, now: now) }
			.enumerated()
			.sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
			.map(\.element)
	}
}

// MARK: - Coverage gaps

/// A stretch when nobody is on call on one schedule.
public struct OnCallGapRow: Hashable, Sendable, Identifiable {
	public let scheduleId: String
	public let scheduleName: String
	public let start: Date
	public let end: Date
	/// The gap has started: nobody is on call at the moment.
	public let isNow: Bool
	/// It runs to the end of what the overview covers, so its real end is unknown.
	public let isOpenEnded: Bool

	public var id: String { "\(scheduleId)|\(start.timeIntervalSince1970)" }

	/// The line under the gap's dates.
	public var detail: String {
		if isNow { return "Nobody is on call right now" }
		if isOpenEnded { return "Nobody is scheduled after this" }
		return "Nobody is on call for \(IncidentWording.span(end.timeIntervalSince(start)))"
	}
}

extension OnCallOverview {
	/// The gaps still ahead or under way, earliest first. Pass a schedule to
	/// keep only its own.
	public func gapRows(now: Date = Date(), scheduleId: String? = nil) -> [OnCallGapRow] {
		let windowEnd = windowEnd
		return schedules.filter { scheduleId == nil || $0.id == scheduleId }
			.flatMap { schedule in
				schedule.coverageGaps.compactMap { gap -> OnCallGapRow? in
					guard let start = ResolvedTimeWindow.parse(gap.startsAt), let end = ResolvedTimeWindow.parse(gap.endsAt),
						end > start, end > now
					else { return nil }
					return OnCallGapRow(
						scheduleId: schedule.id,
						scheduleName: schedule.name,
						start: start,
						end: end,
						isNow: start <= now,
						isOpenEnded: windowEnd.map { end >= $0 - OnCallSchedule.seam } ?? false
					)
				}
			}
			.sorted { ($0.start, $0.scheduleName) < ($1.start, $1.scheduleName) }
	}
}

// MARK: - Upcoming handoffs

/// A moment ahead when someone takes a schedule over.
public struct OnCallHandoffRow: Hashable, Sendable, Identifiable {
	public let userId: String
	public let name: String
	public let isViewer: Bool
	public let at: Date
	public let isOverride: Bool

	public var id: String { "\(userId)|\(at.timeIntervalSince1970)" }
}

extension OnCallOverview {
	/// The handoffs ahead on one schedule, earliest first. A person's own
	/// back-to-back shifts are one stretch, so only its start is a handoff.
	public func upcomingHandoffs(on schedule: OnCallSchedule, now: Date = Date()) -> [OnCallHandoffRow] {
		var rows: [OnCallHandoffRow] = []
		var previous: OnCallPeriod?
		for period in schedule.periods {
			defer { previous = period }
			guard period.start > now else { continue }
			if let previous, previous.userId == period.userId, period.start <= previous.end + OnCallSchedule.seam {
				continue
			}
			rows.append(
				OnCallHandoffRow(
					userId: period.userId,
					name: name(of: period.userId),
					isViewer: isViewer(period.userId),
					at: period.start,
					isOverride: period.isOverride
				)
			)
		}
		return rows
	}
}

// MARK: - Coverage strip

/// Who covers a schedule over the overview's window, as fractions of it: one
/// lane per person, the stretches nobody covers, and where each day falls.
public struct OnCallCoverage: Hashable, Sendable {
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
		public let name: String
		public let isViewer: Bool
		public let segments: [Segment]

		public var id: String { userId }
		/// The fraction of the window this person covers.
		public var share: Double { segments.reduce(0) { $0 + $1.length } }
	}

	/// One calendar day's slice of the window. The first and last are partial.
	public struct Day: Hashable, Sendable, Identifiable {
		/// Where the slice starts: the window's start, then each midnight.
		public let date: Date
		public let start: Double
		public let end: Double

		public var id: Date { date }
	}

	public let start: Date
	public let end: Date
	/// In order of first appearance, so whoever is on call now leads.
	public let lanes: [Lane]
	public let gaps: [Segment]
	public let days: [Day]

	public var duration: TimeInterval { end.timeIntervalSince(start) }
	/// The window in whole days, for "next 14 days".
	public var dayCount: Int { Int((duration / 86_400).rounded()) }
	public var hasOverrides: Bool { lanes.contains { $0.segments.contains(where: \.isOverride) } }
}

extension OnCallOverview {
	/// The coverage strip for one schedule. Nil when the window's bounds will not parse.
	public func coverage(of schedule: OnCallSchedule, calendar: Calendar = .current) -> OnCallCoverage? {
		guard let start = ResolvedTimeWindow.parse(generatedAt), let end = windowEnd, end > start else { return nil }
		let length = end.timeIntervalSince(start)
		let seam = OnCallSchedule.seam / length
		func fraction(_ date: Date) -> Double { min(1, max(0, date.timeIntervalSince(start) / length)) }

		var order: [String] = []
		var segments: [String: [OnCallCoverage.Segment]] = [:]
		for period in schedule.periods where period.end > start && period.start < end {
			let segment = OnCallCoverage.Segment(
				start: fraction(period.start), end: fraction(period.end), isOverride: period.isOverride
			)
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

		let gaps = schedule.coverageGaps.compactMap { gap -> OnCallCoverage.Segment? in
			guard let from = ResolvedTimeWindow.parse(gap.startsAt), let to = ResolvedTimeWindow.parse(gap.endsAt) else {
				return nil
			}
			let segment = OnCallCoverage.Segment(start: fraction(from), end: fraction(to))
			return segment.length > 0 ? segment : nil
		}
		.sorted { $0.start < $1.start }

		var days: [OnCallCoverage.Day] = []
		var cursor = start
		while cursor < end {
			let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: cursor)) ?? end
			let next = min(max(midnight, cursor.addingTimeInterval(1)), end)
			days.append(.init(date: cursor, start: fraction(cursor), end: fraction(next)))
			cursor = next
		}

		return OnCallCoverage(
			start: start,
			end: end,
			lanes: order.map { userId in
				.init(userId: userId, name: name(of: userId), isViewer: isViewer(userId), segments: segments[userId] ?? [])
			},
			gaps: gaps,
			days: days
		)
	}
}
