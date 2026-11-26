import MapleAPI
import SwiftUI

/// One schedule, read-only: who holds it, who covers the window ahead, and
/// where an override or a gap changes that. Drawn from the same overview
/// document as the On call screen; editing layers stays on the web.
struct ScheduleView: View {
	let scheduleID: String
	/// The overview the On call screen already holds, when it opened this one.
	var seed: OnCallOverview? = nil

	@Environment(SessionController.self) private var session
	@State private var model: OnCallModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Schedule not found",
				emptyMessage: "This schedule no longer exists.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { overview in
				if let schedule = overview.schedule(id: scheduleID) {
					// Time left follows the clock between reads.
					TimelineView(.periodic(from: .now, by: 60)) { context in
						ScheduleContent(overview: overview, schedule: schedule, now: context.date)
					}
				}
			}
		}
		.navigationTitle("")
		.navigationBarTitleDisplayMode(.inline)
		.mapleScreen(Screen.onCallSchedule)
		.task(id: session.dataGeneration) {
			let scheduleID = scheduleID
			let model =
				if let model, model.generation == session.dataGeneration { model } else {
					OnCallModel(api: session.api, session: session, screen: Screen.onCallSchedule) {
						$0.schedule(id: scheduleID) == nil
					}
				}
			self.model = model
			await model.start(seed: seed)
		}
	}
}

private struct ScheduleContent: View {
	let overview: OnCallOverview
	let schedule: OnCallSchedule
	let now: Date

	/// A twelve-hour rotation hands off 28 times in the window; the rest are counted.
	private static let handoffLimit = 8

	var body: some View {
		let coverage = overview.coverage(of: schedule)
		let handoffs = overview.upcomingHandoffs(on: schedule, now: now)
		let gaps = overview.gapRows(now: now, scheduleId: schedule.id)
		let days = coverage?.dayCount ?? 14
		VStack(alignment: .leading, spacing: 24) {
			VStack(alignment: .leading, spacing: 16) {
				header
				ScheduleNowCard(
					overview: overview, status: schedule.status(now: now, windowEnd: overview.windowEnd), days: days, now: now
				)
			}

			if let coverage {
				TitledSection(SectionHeader(title: "Who covers", note: "next \(days) days")) {
					CoverageStrip(coverage: coverage)
				}
			}

			TitledSection(SectionHeader(title: "Upcoming")) {
				if handoffs.isEmpty {
					Text("No handoffs in the next \(days) days.")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.frame(maxWidth: .infinity, alignment: .leading)
						.hairlineCard(padding: 12)
				} else {
					VStack(alignment: .leading, spacing: 8) {
						VStack(spacing: 0) {
							let shown = Array(handoffs.prefix(Self.handoffLimit))
							ForEach(shown) { handoff in
								HandoffRow(handoff: handoff)
								if handoff.id != shown.last?.id { Hairline() }
							}
						}
						.hairlineCard()
						if handoffs.count > Self.handoffLimit {
							Text("and \(handoffs.count - Self.handoffLimit) more in the next \(days) days")
								.font(Typo.tiny)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
					}
				}
			}

			if !gaps.isEmpty {
				TitledSection(SectionHeader(title: "Coverage gaps", count: "\(gaps.count)")) {
					VStack(spacing: 8) {
						ForEach(gaps) { gap in
							OnCallGapCard(gap: gap, showsSchedule: false)
						}
					}
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.padding(.bottom, 24)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(schedule.name)
				.font(Typo.pageTitle)
				.tracking(-0.6)
				.foregroundStyle(Token.foreground)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
			// The rotation's own words, in the schedule's zone; every time below
			// is in the device's.
			Text("\(schedule.rotationSummary) · \(schedule.timeZone)")
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)
		}
	}
}

/// Who holds the schedule now, how long is left and who takes over. Someone
/// who stays on call gets no countdown. With nobody on call it says so in the
/// warning colour, and who picks it up.
private struct ScheduleNowCard: View {
	let overview: OnCallOverview
	let status: OnCallScheduleStatus
	let days: Int
	let now: Date

	var body: some View {
		switch status {
		case .covered(let period, let end):
			VStack(alignment: .leading, spacing: 0) {
				HStack(spacing: 6) {
					OnCallDot()
					Text("On call now").sectionLabelStyle(tint: Token.foreground)
					Spacer(minLength: 8)
					if let until = end.date {
						Text(OnCallWording.remaining(until: until, now: now))
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					}
				}
				HStack(spacing: 8) {
					Text(overview.name(of: period.userId))
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					if period.isOverride {
						MapleBadge(text: "Override", tint: Token.mutedForeground, outlined: true)
					}
				}
				.padding(.top, 8)
				Text(line(end))
					.font(Typo.small)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
					.padding(.top, 3)
			}
			.hairlineCard(padding: 12)
			.accessibilityElement(children: .combine)

		case .uncovered(let next):
			VStack(alignment: .leading, spacing: 0) {
				Text("On call now").sectionLabelStyle(tint: Token.severityWarn)
				Text("Nobody")
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.severityWarn)
					.padding(.top, 8)
				Text(
					next.map { "\(overview.name(of: $0.userId)) takes over \(Format.dayTime($0.start))" }
						?? "No shift starts in the next \(days) days"
				)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)
				.padding(.top, 3)
			}
			.padding(.leading, 14)
			.padding(.trailing, 12)
			.padding(.vertical, 12)
			.severityRail(Token.severityWarn)
			.hairlineCard()
			.accessibilityElement(children: .combine)
		}
	}

	private func line(_ end: OnCallEnd) -> String {
		switch end {
		case .handoff(let date, let userId):
			"Hands off \(Format.dayTime(date)) to \(overview.name(of: userId, midSentence: true))"
		case .gap(let date): "Ends \(Format.dayTime(date)), and nobody takes over"
		case .unknown(let date): "On call until \(Format.dayTime(date))"
		case .continues: OnCallWording.noHandoff(inNext: days)
		}
	}
}

/// A handoff ahead: who, when, and whether an override put them there.
private struct HandoffRow: View {
	let handoff: OnCallHandoffRow

	var body: some View {
		TableRow {
			HStack(spacing: 8) {
				PersonDot(userId: handoff.userId)
				Text(handoff.name)
					.font(handoff.isViewer ? Typo.smallMedium : Typo.small)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				if handoff.isOverride {
					MapleBadge(text: "Override", tint: Token.mutedForeground, outlined: true)
				}
			}
		} trailing: {
			Text(Format.dayTime(handoff.at))
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				.fixedSize()
		}
		.accessibilityElement(children: .combine)
	}
}

// MARK: - Coverage strip

/// The window as one lane per person, under a row of weekday letters. An
/// override is outlined, and what nobody covers gets a lane of its own.
private struct CoverageStrip: View {
	let coverage: OnCallCoverage

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			DayAxis(days: coverage.days)
			ForEach(coverage.lanes) { lane in
				self.lane(
					lane.name,
					share: lane.share,
					segments: lane.segments,
					tint: PersonDot.color(for: lane.userId),
					emphasized: lane.isViewer
				)
			}
			if !coverage.gaps.isEmpty {
				lane(
					"Nobody",
					share: coverage.gaps.reduce(0) { $0 + $1.length },
					segments: coverage.gaps,
					tint: Token.severityWarn,
					labelTint: Token.severityWarn
				)
			}
			if coverage.hasOverrides {
				HStack(spacing: 6) {
					RoundedRectangle(cornerRadius: 2)
						.strokeBorder(Token.foreground, lineWidth: 1.5)
						.frame(width: 8, height: 8)
					Text("Override")
				}
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.accessibilityHidden(true)
			}
		}
		.hairlineCard(padding: 12)
	}

	private func lane(
		_ name: String, share: Double, segments: [OnCallCoverage.Segment], tint: Color, emphasized: Bool = false,
		labelTint: Color = Token.foreground
	) -> some View {
		let covered = IncidentWording.span(share * coverage.duration)
		return VStack(alignment: .leading, spacing: 4) {
			HStack(alignment: .firstTextBaseline) {
				Text(name)
					.font(emphasized ? Typo.tinyMedium : Typo.tiny)
					.foregroundStyle(labelTint)
					.lineLimit(1)
				Spacer(minLength: 8)
				Text(covered)
					.font(Typo.micro)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
			LaneBar(segments: segments, days: coverage.days, tint: tint)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			name == "Nobody" ? "Nobody on call for \(covered)" : "\(name): on call for \(covered)"
		)
	}
}

/// A weekday letter over each day's slice of the window, today's in foreground.
private struct DayAxis: View {
	let days: [OnCallCoverage.Day]

	var body: some View {
		GeometryReader { proxy in
			let width = proxy.size.width
			ForEach(Array(days.enumerated()), id: \.element.id) { index, day in
				// The window starts and ends mid-day; a sliver has no room for a letter.
				if width * (day.end - day.start) >= 8 {
					Text(day.date.formatted(.dateTime.weekday(.narrow)))
						.font(Typo.micro)
						.foregroundStyle(index == 0 ? Token.foreground : Token.mutedForeground)
						.position(x: width * (day.start + day.end) / 2, y: proxy.size.height / 2)
				}
			}
		}
		.frame(height: 12)
		.accessibilityHidden(true)
	}
}

/// One lane: a muted track cut at each midnight, with the covered stretches on it.
private struct LaneBar: View {
	let segments: [OnCallCoverage.Segment]
	let days: [OnCallCoverage.Day]
	let tint: Color

	/// A ten-hour override is a few points wide; it must still be findable.
	private static let minimumWidth: CGFloat = 4

	var body: some View {
		GeometryReader { proxy in
			let width = proxy.size.width
			ZStack(alignment: .leading) {
				RoundedRectangle(cornerRadius: 3)
					.fill(Token.muted.opacity(0.5))
				ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
					let segmentWidth = max(Self.minimumWidth, width * segment.length - 1)
					RoundedRectangle(cornerRadius: 3)
						.fill(tint)
						.overlay {
							if segment.isOverride {
								RoundedRectangle(cornerRadius: 3).strokeBorder(Token.foreground, lineWidth: 1.5)
							}
						}
						.frame(width: segmentWidth)
						.offset(x: min(width * segment.start, width - segmentWidth))
				}
				// Day ticks, over the bars so a week-long shift still shows its days.
				ForEach(days.dropFirst()) { day in
					Rectangle()
						.fill(Token.card.opacity(0.55))
						.frame(width: 1)
						.offset(x: width * day.start)
				}
			}
		}
		.frame(height: 16)
	}
}
