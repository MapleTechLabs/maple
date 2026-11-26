import MapleWidgetData
import SwiftUI
import WidgetKit

/// The On call widget. Small answers "am I on call", medium "who is", for
/// every schedule. Colour is spent twice: green on the dot that says you are
/// on call, the warning amber on a schedule nobody holds.
struct OnCallWidgetView: View {
	let entry: OnCallEntry

	@Environment(\.widgetFamily) private var family

	var body: some View {
		content
			.widgetURL(OnCallWidgetKind.onCallURL(organizationId: entry.organizationId))
	}

	@ViewBuilder
	private var content: some View {
		switch family {
		case .accessoryInline: InlineOnCallView(entry: entry)
		case .accessoryRectangular: RectangularOnCallView(entry: entry)
		case .systemSmall: SmallOnCallView(entry: entry)
		default: MediumOnCallView(entry: entry)
		}
	}
}

extension OnCallFrame {
	fileprivate init(entry: OnCallEntry, isAccessory: Bool = false, @ViewBuilder content: @escaping (OnCallSnapshot) -> Content) {
		self.init(
			title: "On call",
			snapshot: entry.snapshot,
			date: entry.date,
			isSignedOut: entry.organizationId == nil,
			isAccessory: isAccessory,
			isPlaceholder: entry.isPlaceholder,
			content: content
		)
	}
}

// MARK: - Home Screen

private struct SmallOnCallView: View {
	let entry: OnCallEntry

	var body: some View {
		OnCallFrame(entry: entry) { snapshot in
			VStack(alignment: .leading, spacing: 0) {
				switch snapshot.viewerState(at: entry.date) {
				case .onCall(let current):
					PagesHeader(title: "On call", tint: Token.success)
					// On a second schedule too: counted, as the app's shift card counts it.
					let schedule = current.scheduleName + (current.otherSchedules > 0 ? " +\(current.otherSchedules)" : "")
					if let until = current.end.date {
						TimeLeft(until: until, now: entry.date)
							.font(Typo.pageTitle)
							.foregroundStyle(Token.foreground)
							.lineLimit(1)
							.minimumScaleFactor(0.7)
							.padding(.top, 12)
						caption("left on this shift")
						Spacer(minLength: 4)
						subject(schedule)
						footnote(snapshot.thenPhrase(current.end))
					} else {
						// Nobody takes over, so there is no time left to count:
						// the schedule stands where the countdown would.
						Text(schedule)
							.font(Typo.title)
							.foregroundStyle(Token.foreground)
							.lineLimit(2)
							.minimumScaleFactor(0.8)
							.padding(.top, 12)
						caption(WidgetOnCallWording.noHandoffScheduled)
						Spacer(minLength: 4)
						footnote(nil)
					}
				case .offCall(let next):
					PagesHeader(title: "Next shift", tint: nil, titleTint: Token.mutedForeground)
					Text(WidgetTime.handoffTime(next.start, now: entry.date, compact: true))
						.font(Typo.title)
						.tabularNumbers()
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
						.minimumScaleFactor(0.7)
						.padding(.top, 12)
					LeadTime(to: next.start, now: entry.date)
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
						.padding(.top, 4)
					Spacer(minLength: 4)
					subject(next.scheduleName)
					footnote(snapshot.afterPhrase(next.before))
				case .noShifts:
					PagesHeader(title: "Off call", tint: nil, titleTint: Token.mutedForeground)
					Text("No shifts")
						.font(Typo.title)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
						.padding(.top, 12)
					caption("in the next 60 days")
					Spacer(minLength: 4)
					if let name = snapshot.organizationName { subject(name) }
					footnote(nil)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}

	private func caption(_ text: String) -> some View {
		Text(text)
			.font(Typo.tiny)
			.foregroundStyle(Token.mutedForeground)
			.lineLimit(1)
			.padding(.top, 4)
	}

	private func subject(_ text: String) -> some View {
		Text(text)
			.font(Typo.smallMedium)
			.foregroundStyle(Token.foreground)
			.lineLimit(1)
	}

	/// The last line: who is on the other side of the handoff, or the one thing
	/// that makes a refused widget current again.
	@ViewBuilder
	private func footnote(_ text: String?) -> some View {
		if let text = entry.needsApp ? "Open Maple to refresh" : text {
			Text(text)
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				.padding(.top, 2)
		}
	}
}

private struct MediumOnCallView: View {
	let entry: OnCallEntry

	/// Four rows fit. With more schedules than that the last row is a count.
	private static let rowLimit = 4

	var body: some View {
		OnCallFrame(entry: entry) { snapshot in
			let rows = snapshot.tableRows(at: entry.date)
			let shown = rows.count > Self.rowLimit ? Self.rowLimit - 1 : rows.count
			let isDense = rows.count > 3
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .firstTextBaseline) {
					PagesHeader(title: "On call now", tint: nil)
					Spacer(minLength: 8)
					Text(entry.needsApp ? "Open Maple to refresh" : snapshot.organizationName ?? "")
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
				.padding(.bottom, isDense ? 8 : 12)
				if rows.isEmpty {
					Text("No schedules")
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
					Text("Nobody is set up to be on call here.")
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
						.padding(.top, 3)
				}
				ForEach(Array(rows.prefix(shown).enumerated()), id: \.element.id) { index, row in
					if index > 0 { rule(isDense: isDense) }
					OnCallRowView(row: row, now: entry.date)
				}
				if rows.count > shown {
					rule(isDense: isDense)
					MoreSchedulesLine(hidden: Array(rows.dropFirst(shown)))
				}
				Spacer(minLength: 0)
			}
		}
	}

	private func rule(isDense: Bool) -> some View {
		Divider().overlay(Token.border).padding(.vertical, isDense ? 5 : 8)
	}
}

/// Schedule, who, until. The owner reads as the medium weight, and a schedule
/// nobody holds in the warning colour, beside the word that says so.
private struct OnCallRowView: View {
	let row: OnCallSnapshot.Row
	let now: Date

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 8) {
			Text(row.name)
				.font(Typo.small)
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
			Spacer(minLength: 4)
			Text(row.whoLabel)
				.font(row.who == .viewer ? Typo.smallMedium : Typo.small)
				.foregroundStyle(row.isUncovered ? Token.severityWarn : Token.foreground)
				.lineLimit(1)
				.layoutPriority(1)
			Text(row.untilLabel(at: now))
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				.frame(minWidth: 64, alignment: .trailing)
				.layoutPriority(2)
		}
	}
}

/// The schedules the table had no room for. One with nobody on it is the row
/// most worth knowing about, so it is still said.
private struct MoreSchedulesLine: View {
	let hidden: [OnCallSnapshot.Row]

	var body: some View {
		let uncovered = hidden.filter(\.isUncovered).count
		Text(uncovered > 0 ? "+\(hidden.count) more · \(uncovered) with nobody on call" : "+\(hidden.count) more")
			.font(Typo.micro)
			.foregroundStyle(uncovered > 0 ? Token.severityWarn : Token.mutedForeground)
			.lineLimit(1)
	}
}

// MARK: - Lock Screen

private struct RectangularOnCallView: View {
	let entry: OnCallEntry

	var body: some View {
		OnCallFrame(entry: entry, isAccessory: true) { snapshot in
			let text = snapshot.lockScreenText(at: entry.date)
			VStack(alignment: .leading, spacing: 2) {
				Text(text.lead)
					.font(.headline)
					.widgetAccentable()
				Text(text.detail)
					.font(.caption)
					.lineLimit(1)
				if let second = text.second {
					Text(second)
						.font(.caption2)
						.foregroundStyle(.secondary)
						.lineLimit(1)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}
}

private struct InlineOnCallView: View {
	let entry: OnCallEntry

	var body: some View {
		if let snapshot = entry.snapshot, snapshot.covers(entry.date) {
			Text(snapshot.lockScreenText(at: entry.date).inline)
		} else {
			Text("Open Maple")
		}
	}
}

// MARK: - Pieces

/// The on-call widgets' two outer states: a read that still reaches the
/// entry's date, or a pointer to the app.
struct OnCallFrame<Content: View>: View {
	let title: String
	let snapshot: OnCallSnapshot?
	let date: Date
	let isSignedOut: Bool
	var isAccessory = false
	var isPlaceholder = false
	@ViewBuilder let content: (OnCallSnapshot) -> Content

	var body: some View {
		Group {
			if let snapshot, snapshot.covers(date) {
				content(snapshot)
			} else {
				VStack(alignment: .leading, spacing: 4) {
					if !isAccessory { PagesHeader(title: title, tint: Token.mutedForeground) }
					Text("Open Maple")
						.font(isAccessory ? .headline : Typo.bodyMedium)
						.foregroundStyle(isAccessory ? Color.primary : Token.foreground)
					Text(reason)
						.font(isAccessory ? .caption2 : Typo.tiny)
						.foregroundStyle(isAccessory ? Color.secondary : Token.mutedForeground)
					if !isAccessory { Spacer(minLength: 0) }
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.redacted(reason: isPlaceholder ? .placeholder : [])
	}

	private var reason: String {
		if isSignedOut { return "Sign in to see who is on call." }
		// A read older than its own window would name whoever was on call then.
		return snapshot == nil ? "Nothing has been read yet." : "This schedule is out of date."
	}
}

/// The time left on a shift: "3d 6h" while days remain, then a clock that ticks
/// on its own through the last day, where an hourly entry would fall behind.
struct TimeLeft: View {
	let until: Date
	let now: Date

	var body: some View {
		if until.timeIntervalSince(now) >= 86_400 {
			Text(WidgetTime.span(until.timeIntervalSince(now)))
				.tabularNumbers()
		} else {
			Text(timerInterval: now...max(now, until), countsDown: true)
				.monospacedDigit()
		}
	}
}

/// "in 6 days", and inside the last day a clock that ticks on its own.
struct LeadTime: View {
	let start: Date
	let now: Date

	init(to start: Date, now: Date) {
		self.start = start
		self.now = now
	}

	var body: some View {
		if start.timeIntervalSince(now) >= 86_400 {
			Text(WidgetTime.lead(to: start, now: now))
		} else {
			Text("in \(Text(timerInterval: now...max(now, start), countsDown: true))")
				.monospacedDigit()
		}
	}
}
