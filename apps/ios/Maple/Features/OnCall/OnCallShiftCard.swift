import MapleAPI
import SwiftUI

/// The viewer's shift on Overview: on call now and until when, or the next
/// shift. A shift with no end in sight says so, and draws no progress. Opens
/// the On call screen. Draws nothing for an organization with no schedules.
struct OnCallShiftCard: View {
	let overview: OnCallOverview

	var body: some View {
		// The state follows the clock, not the last read: a shift that ended a
		// minute ago must not go on saying "On call now".
		TimelineView(.periodic(from: .now, by: 60)) { context in
			let state = overview.viewerState(now: context.date)
			if state != .noShifts || !overview.schedules.isEmpty {
				NavigationLink(value: Route.onCall(seed: overview)) {
					card(state, now: context.date)
				}
				.buttonStyle(.plain)
				.accessibilityHint("Opens on call")
			}
		}
	}

	private struct Lines {
		let label: String
		let title: String
		let detail: String
		var progress: Double?
	}

	private func lines(_ state: OnCallViewerState, now: Date) -> Lines {
		switch state {
		case .onCall(let current):
			let others = current.otherSchedules > 0 ? " +\(current.otherSchedules)" : ""
			let until = current.end.date.map { "until \(Format.handoffTime($0, now: now))" }
			let detail = [until ?? OnCallWording.noHandoffScheduled, overview.handsOffPhrase(current.end)]
			return Lines(
				label: "On call now",
				title: current.shift.scheduleName + others,
				detail: detail.compactMap { $0 }.joined(separator: " · "),
				progress: current.progress(now: now)
			)
		case .offCall(let next):
			return Lines(
				label: "Next shift",
				title: next.scheduleName,
				detail: "\(Format.handoffTime(next.start, now: now)) · \(OnCallWording.lead(to: next.start, now: now))"
			)
		case .noShifts:
			let count = overview.schedules.count
			return Lines(
				label: "Off call",
				title: "No shifts in the next 60 days",
				detail: "\(count == 1 ? "1 schedule" : "\(count) schedules") · see who is on call"
			)
		}
	}

	private func card(_ state: OnCallViewerState, now: Date) -> some View {
		let lines = lines(state, now: now)
		return VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: 6) {
				if state.isOnCall { OnCallDot() }
				Text(lines.label)
					.sectionLabelStyle(tint: state.isOnCall ? Token.foreground : Token.mutedForeground)
				Spacer(minLength: 8)
				OnCallChevron()
			}
			Text(lines.title)
				.font(Typo.bodyMedium)
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
				.padding(.top, 8)
			Text(lines.detail)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(2)
				.padding(.top, 3)
			if let progress = lines.progress {
				ShiftProgress(value: progress)
					.padding(.top, 12)
			}
		}
		.hairlineCard(padding: 12)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}

/// How far through the shift the viewer is: a hairline track, filled to now.
private struct ShiftProgress: View {
	let value: Double

	var body: some View {
		GeometryReader { proxy in
			ZStack(alignment: .leading) {
				Capsule().fill(Token.input)
				Capsule()
					.fill(Token.foreground)
					.frame(width: max(3, proxy.size.width * value))
			}
		}
		.frame(height: 3)
		.accessibilityHidden(true)
	}
}
