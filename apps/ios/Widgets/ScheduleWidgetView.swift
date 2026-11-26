import MapleWidgetData
import SwiftUI
import WidgetKit

/// The Schedule widget, top to bottom in the order of the question: which
/// schedule, who is on call and until when, then the week as one strip. An
/// override is named underneath, because it is the part of a week people forget.
struct ScheduleWidgetView: View {
	let entry: ScheduleEntry

	var body: some View {
		OnCallFrame(
			title: "Schedule",
			snapshot: entry.snapshot,
			date: entry.date,
			isSignedOut: entry.isSignedOut,
			isPlaceholder: entry.isPlaceholder
		) { snapshot in
			if let schedule = entry.schedule(in: snapshot) {
				ScheduleWeekView(snapshot: snapshot, schedule: schedule, now: entry.date, needsApp: entry.needsApp)
			} else {
				MissingScheduleView(wasPicked: entry.pickedId != nil)
			}
		}
		.widgetURL(ScheduleWidgetKind.scheduleURL(id: shownScheduleId, organizationId: entry.organizationId))
	}

	/// A tap opens the schedule on the widget, or On call when it shows none.
	private var shownScheduleId: String? {
		guard let snapshot = entry.snapshot, snapshot.covers(entry.date) else { return nil }
		return entry.schedule(in: snapshot)?.id
	}
}

private struct ScheduleWeekView: View {
	let snapshot: OnCallSnapshot
	let schedule: OnCallSnapshot.Schedule
	let now: Date
	let needsApp: Bool

	var body: some View {
		let line = snapshot.scheduleLine(for: schedule, at: now)
		let strip = snapshot.strip(for: schedule, at: now)
		let isUncovered = line.who == .nobody
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .firstTextBaseline) {
				PagesHeader(title: schedule.name, tint: nil)
				Spacer(minLength: 8)
				Text(needsApp ? "Open Maple to refresh" : "next \(OnCallSnapshot.Strip.dayCount) days")
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
					.layoutPriority(1)
			}
			HStack(spacing: 6) {
				Circle()
					.fill(isUncovered ? Token.severityWarn : Token.success)
					.frame(width: 6, height: 6)
				Text("\(who(line, isUncovered: isUncovered)) \(line.detail)")
					.font(Typo.small)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
			.padding(.top, 10)
			Spacer(minLength: 6)
			DayLetters(days: strip.days)
			WeekStrip(strip: strip)
				.frame(height: 16)
				.padding(.top, 5)
			if let override = strip.overrideLine {
				Text(override)
					.font(Typo.micro)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
					.padding(.top, 6)
			}
		}
		.accessibilityElement(children: .combine)
	}

	/// "You" in the medium weight, as the On call table writes the owner.
	private func who(_ line: OnCallSnapshot.ScheduleLine, isUncovered: Bool) -> Text {
		Text(line.whoLabel)
			.font(line.who == .viewer ? Typo.smallMedium : Typo.small)
			.foregroundStyle(isUncovered ? Token.severityWarn : Token.foreground)
	}
}

/// The weekday letters over the strip, today's in the foreground colour.
private struct DayLetters: View {
	let days: [OnCallSnapshot.Strip.Day]

	var body: some View {
		HStack(spacing: 0) {
			ForEach(Array(days.enumerated()), id: \.offset) { index, day in
				Text(day.letter)
					.font(Typo.micro)
					.foregroundStyle(index == 0 ? Token.foreground : Token.mutedForeground)
					.frame(maxWidth: .infinity)
			}
		}
		.accessibilityHidden(true)
	}
}

/// The week as one track. Each person's stretches are in their own colour with
/// their name where it fits, an override is outlined as it is on the app's
/// Schedule screen, and what nobody covers is the warning colour.
private struct WeekStrip: View {
	let strip: OnCallSnapshot.Strip

	/// A few hours of override are a few points wide. They must still be findable.
	private static let minimumWidth: CGFloat = 4

	var body: some View {
		GeometryReader { proxy in
			let width = proxy.size.width
			ZStack(alignment: .leading) {
				RoundedRectangle(cornerRadius: 3)
					.fill(Token.muted.opacity(0.5))
				ForEach(Array(strip.gaps.enumerated()), id: \.offset) { _, gap in
					bar(gap, label: "Nobody", tint: Token.severityWarn, width: width)
				}
				ForEach(strip.lanes) { lane in
					ForEach(Array(lane.segments.enumerated()), id: \.offset) { _, segment in
						// The person's colour in the app, hashed from the same id.
						bar(segment, label: lane.label, tint: ServiceColor.color(for: lane.userId), width: width)
					}
				}
			}
		}
		.accessibilityHidden(true)
	}

	private func bar(_ segment: OnCallSnapshot.Strip.Segment, label: String, tint: Color, width: CGFloat) -> some View {
		let barWidth = max(Self.minimumWidth, width * segment.length - 1)
		return RoundedRectangle(cornerRadius: 3)
			.fill(tint)
			.overlay(alignment: .leading) {
				// The name only where the bar has room for all of it.
				ViewThatFits(in: .horizontal) {
					Text(label)
						.font(Typo.microMedium)
						.foregroundStyle(Token.primaryForeground)
						.lineLimit(1)
						.fixedSize()
						.padding(.horizontal, 4)
					Color.clear
				}
			}
			.overlay {
				if segment.isOverride {
					RoundedRectangle(cornerRadius: 3).strokeBorder(Token.foreground, lineWidth: 1.5)
				}
			}
			.frame(width: barWidth)
			.offset(x: min(width * segment.start, width - barWidth))
	}
}

/// Nothing to draw: the picked schedule is gone, or there are none at all.
private struct MissingScheduleView: View {
	let wasPicked: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			PagesHeader(title: "Schedule", tint: Token.mutedForeground)
			Text(wasPicked ? "Schedule not found" : "No schedules")
				.font(Typo.bodyMedium)
				.foregroundStyle(Token.foreground)
			Text(wasPicked ? "Edit the widget to pick another." : "Nobody is set up to be on call here.")
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
			Spacer(minLength: 0)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}
