import MapleAPI
import SwiftUI

/// Who is on call, and when the viewer is: their shifts, who holds each
/// schedule right now, and the stretches nobody covers.
struct OnCallView: View {
	/// The overview the Overview card already holds, when it opened this screen.
	var seed: OnCallOverview? = nil

	@Environment(SessionController.self) private var session
	@State private var model: OnCallModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "No on-call schedules",
				emptyMessage:
					"Schedules are set up on the web. Once your organization has one, your shifts and who is on call show up here.",
				header: { OnCallHeader(overview: model?.loader.state.value) },
				skeleton: { SkeletonList(rowHeight: 56, rows: 6) }
			) { overview in
				// Time left and "Now" follow the clock between reads.
				TimelineView(.periodic(from: .now, by: 60)) { context in
					OnCallContent(overview: overview, now: context.date)
				}
			}
		}
		.navigationTitle("")
		.navigationBarTitleDisplayMode(.inline)
		.mapleScreen(Screen.onCall)
		.task(id: session.dataGeneration) {
			let model =
				if let model, model.generation == session.dataGeneration { model } else {
					OnCallModel(api: session.api, session: session, screen: Screen.onCall) {
						$0.schedules.isEmpty && $0.myShifts.isEmpty
					}
				}
			self.model = model
			await model.start(seed: seed)
		}
	}
}

/// The title and the line under it: `● You are on call · 3d 6h left on Platform primary`,
/// or `· no handoff scheduled on Platform primary` when the shift has no end in sight.
private struct OnCallHeader: View {
	let overview: OnCallOverview?

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("On call")
				.font(Typo.pageTitle)
				.tracking(-0.6)
				.foregroundStyle(Token.foreground)
				.accessibilityAddTraits(.isHeader)
			if let overview {
				TimelineView(.periodic(from: .now, by: 60)) { context in
					let state = overview.viewerState(now: context.date)
					let line = state.headline(now: context.date)
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						if state.isOnCall {
							OnCallDot()
								.alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
						}
						(Text(line.lead).foregroundStyle(Token.foreground)
							+ Text(" \(line.detail)").foregroundStyle(Token.mutedForeground))
							.font(Typo.small)
							.tabularNumbers()
							.fixedSize(horizontal: false, vertical: true)
					}
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

private struct OnCallContent: View {
	let overview: OnCallOverview
	let now: Date

	/// More rows than this is a daily rotation's whole two months; the rest are counted.
	private static let shiftLimit = 8
	private static let gapLimit = 6

	var body: some View {
		let shifts = overview.viewerShifts(now: now)
		let rows = overview.scheduleRows(now: now)
		let gaps = overview.gapRows(now: now)
		VStack(alignment: .leading, spacing: 24) {
			TitledSection(SectionHeader(title: "Your shifts")) {
				if shifts.isEmpty {
					Text("You have no shifts in the next 60 days.")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.frame(maxWidth: .infinity, alignment: .leading)
						.hairlineCard(padding: 12)
				} else {
					shiftList(shifts)
				}
			}

			if !rows.isEmpty {
				TitledSection(
					SectionHeader(title: "On call now", note: rows.count == 1 ? "1 schedule" : "\(rows.count) schedules")
				) {
					TableCard(
						columns: ["Schedule", "Who", "Until"],
						trailingWidths: [ScheduleNowRow.whoWidth, ScheduleNowRow.untilWidth]
					) {
						ForEach(rows) { row in
							NavigationLink(value: Route.schedule(id: row.id, seed: overview)) {
								ScheduleNowRow(row: row, now: now)
							}
							.buttonStyle(RowButtonStyle())
						}
					}
				}
			}

			if !gaps.isEmpty {
				TitledSection(SectionHeader(title: "Coverage gaps", count: "\(gaps.count)")) {
					VStack(spacing: 8) {
						ForEach(gaps.prefix(Self.gapLimit)) { gap in
							NavigationLink(value: Route.schedule(id: gap.scheduleId, seed: overview)) {
								OnCallGapCard(gap: gap)
							}
							.buttonStyle(.plain)
						}
						if gaps.count > Self.gapLimit {
							more("and \(gaps.count - Self.gapLimit) more in the next 14 days")
						}
					}
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 20)
		.padding(.bottom, 24)
	}

	private func shiftList(_ shifts: [OnCallViewerShift]) -> some View {
		let shown = Array(shifts.prefix(Self.shiftLimit))
		return VStack(alignment: .leading, spacing: 8) {
			VStack(spacing: 0) {
				ForEach(shown) { shift in
					NavigationLink(value: Route.schedule(id: shift.scheduleId, seed: overview)) {
						ViewerShiftRow(overview: overview, shift: shift, now: now)
					}
					.buttonStyle(RowButtonStyle())
					if shift.id != shown.last?.id { Hairline() }
				}
			}
			.hairlineCard()
			if shifts.count > shown.count {
				more("and \(shifts.count - shown.count) more in the next 60 days")
			}
		}
	}

	private func more(_ text: String) -> some View {
		Text(text)
			.font(Typo.tiny)
			.tabularNumbers()
			.foregroundStyle(Token.mutedForeground)
			.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// One of the viewer's shifts: the current one marked Now with its handoff,
/// the rest with how far off they are and their dates. One the 60 day window
/// cut gives no end date: that date is the window's, not the shift's.
private struct ViewerShiftRow: View {
	let overview: OnCallOverview
	let shift: OnCallViewerShift
	let now: Date

	private var isCurrent: Bool { shift.isCurrent(now: now) }

	private var detail: String {
		guard isCurrent else {
			if shift.continues { return "from \(Format.dayTime(shift.start)) · \(OnCallWording.noEndScheduled)" }
			return "\(Format.dayTime(shift.start)) to \(Format.dayTime(shift.end))"
		}
		let end = overview.end(of: shift)
		guard let until = end.date else { return OnCallWording.noEndScheduled }
		return ["until \(Format.dayTime(until))", overview.thenPhrase(end)]
			.compactMap { $0 }
			.joined(separator: " · ")
	}

	var body: some View {
		HStack(spacing: 8) {
			VStack(alignment: .leading, spacing: 4) {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(shift.scheduleName)
						.font(isCurrent ? Typo.bodyMedium : Typo.body)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					if isCurrent {
						MapleBadge(text: "Now", tint: Token.success, outlined: true)
					} else {
						Text(OnCallWording.lead(to: shift.start, now: now))
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
							.fixedSize()
					}
					if shift.isOverride {
						MapleBadge(text: "Override", tint: Token.mutedForeground, outlined: true)
					}
				}
				Text(detail)
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
			Spacer(minLength: 8)
			OnCallChevron()
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 12)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}

/// Schedule, who, until: one line of the "On call now" table.
private struct ScheduleNowRow: View {
	let row: OnCallScheduleRow
	let now: Date

	/// Wide enough for a first and last name, and for `Mon 9:00 AM` or `No handoff`.
	static let whoWidth: CGFloat = 84
	static let untilWidth: CGFloat = 82

	var body: some View {
		TableRow {
			Text(row.name)
				.font(Typo.small)
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
		} trailing: {
			Text(row.whoLabel)
				.font(row.who == .viewer ? Typo.smallMedium : Typo.small)
				.foregroundStyle(row.isUncovered ? Token.severityWarn : Token.foreground)
				.lineLimit(1)
				.frame(width: Self.whoWidth, alignment: .trailing)
			Text(untilText)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				.minimumScaleFactor(0.85)
				.frame(width: Self.untilWidth, alignment: .trailing)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(label)
	}

	/// The Until column: a time, the words for someone who stays on call, or a dash.
	private var untilText: String {
		if row.hasNoHandoff { return OnCallWording.noHandoff }
		return row.until.map { Format.handoffTime($0, now: now, compact: true) } ?? Format.placeholder
	}

	private var label: String {
		let until =
			row.hasNoHandoff
			? ", \(OnCallWording.noHandoffScheduled)"
			: row.until.map { ", until \(Format.handoffTime($0, now: now))" } ?? ""
		return row.isUncovered
			? "\(row.name): nobody on call\(until)"
			: "\(row.name): \(row.whoLabel) on call\(until)"
	}
}
