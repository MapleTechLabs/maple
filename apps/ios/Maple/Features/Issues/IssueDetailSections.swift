import MapleAPI
import SwiftUI

/// The issue detail body: header, stat tiles, occurrences, top frame, sample
/// traces, then linked incidents and notes when there are any.
struct IssueDetailContent: View {
	let issue: ErrorIssueDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			IssueHeader(issue: issue)
			IssueStats(issue: issue)
			IssueOccurrences(points: issue.timeseries)
			IssueStackTrace(topFrame: issue.topFrame)
			IssueSamples(samples: issue.sampleTraces)
			IssueIncidents(incidents: issue.incidents)
			if let notes = issue.notes, !notes.isEmpty {
				TitledSection(SectionHeader(title: "Notes")) {
					Text(notes)
						.font(Typo.small)
						.foregroundStyle(Token.foreground)
						.frame(maxWidth: .infinity, alignment: .leading)
						.hairlineCard(padding: 14)
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 8)
		.padding(.bottom, 24)
	}
}

/// A hairline-bordered badge, no fill: `Error`, `Triage`.
private struct OutlineBadge: View {
	let text: String
	let tint: Color

	var body: some View {
		Text(text)
			.font(Typo.micro)
			.foregroundStyle(tint)
			.padding(.horizontal, 6)
			.frame(height: 20)
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.sm)
					.stroke(tint.opacity(0.6), lineWidth: 1)
			)
			.fixedSize()
	}
}

// MARK: - Header

private struct IssueHeader: View {
	let issue: ErrorIssueDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 6) {
				if let severity = issue.severity {
					OutlineBadge(text: severity.label, tint: severity.tint)
				} else {
					OutlineBadge(text: kindLabel, tint: Token.destructive)
				}
				OutlineBadge(text: issue.workflowState.label, tint: issue.workflowState.tint)
				Text(assignee ?? "Unassigned")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
			.padding(.bottom, 4)

			Text(issue.displayTitle)
				.font(Typo.title)
				.tracking(-0.3)
				.foregroundStyle(Token.foreground)
				.accessibilityAddTraits(.isHeader)

			if let subtitle = issue.displaySubtitle {
				Text(subtitle)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}

			HStack(spacing: 6) {
				ServiceDot(serviceName: issue.serviceName)
				Text(issue.serviceName)
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text("· first \(IssueFormat.ago(issue.firstSeenAt)) · last \(IssueFormat.ago(issue.lastSeenAt))")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
			.tabularNumbers()
			.padding(.top, 2)
		}
	}

	private var kindLabel: String { issue.kind.rawValue.capitalized }

	private var assignee: String? {
		guard let actor = issue.assignedActor else { return nil }
		return actor.agentName ?? actor.userId ?? actor.id
	}
}

// MARK: - Stats

/// Events 24h, linked incidents, first seen, regressed. The detail response
/// has no affected-user count, so the second tile is its incidents instead.
private struct IssueStats: View {
	let issue: ErrorIssueDetail

	private var events24h: Double { issue.timeseries.reduce(0) { $0 + $1.count } }
	private var openIncidents: Int { issue.incidents.filter { $0.status == .open }.count }

	var body: some View {
		StatGrid(columns: 2) {
			StatTile(
				label: "Events 24h",
				value: Format.count(events24h),
				note: ("\(Format.count(issue.occurrenceCount)) all time", Token.mutedForeground)
			)
			StatTile(
				label: "Incidents",
				value: "\(issue.incidents.count)",
				note: openIncidents > 0
					? ("\(openIncidents) open", Token.destructive)
					: (issue.incidents.isEmpty ? "none linked" : "none open", Token.mutedForeground)
			)
			StatTile(
				label: "First seen",
				value: IssueFormat.ago(issue.firstSeenAt),
				note: (Format.absolute(issue.firstSeenAt), Token.mutedForeground)
			)
			StatTile(
				label: "Regressed",
				value: issue.regressionCount > 0 ? "Yes" : "No",
				tint: issue.regressionCount > 0 ? Token.destructive : Token.foreground,
				note: (regressionNote, Token.mutedForeground)
			)
		}
	}

	private var regressionNote: String {
		if issue.regressionCount > 0 {
			let times = issue.regressionCount == 1 ? "once" : "\(Format.count(issue.regressionCount)) times"
			guard let last = issue.lastRegressedAt else { return times }
			return "\(times) · last \(IssueFormat.ago(last))"
		}
		guard let resolved = issue.lastResolvedAt else { return "never resolved" }
		return "resolved \(IssueFormat.ago(resolved))"
	}
}

// MARK: - Occurrences

/// The detail's hourly buckets as bars: red where the issue fired, a muted
/// stub where it did not.
private struct IssueOccurrences: View {
	let points: [ErrorIssueTimeseriesPoint]

	var body: some View {
		if !points.isEmpty {
			let peak = max(points.map(\.count).max() ?? 0, 1)
			TitledSection(SectionHeader(title: "Occurrences", note: "Last 24h")) {
				VStack(spacing: 10) {
					HStack(alignment: .bottom, spacing: 3) {
						ForEach(points, id: \.bucket) { point in
							RoundedRectangle(cornerRadius: 1)
								.fill(point.count > 0 ? Token.chartError : Token.mutedForeground.opacity(0.3))
								.frame(height: point.count > 0 ? max(3, 88 * point.count / peak) : 1.5)
								.frame(maxWidth: .infinity)
						}
					}
					.frame(height: 88, alignment: .bottom)
					HStack {
						Text("24h ago")
						Spacer()
						Text("12h")
						Spacer()
						Text("now")
					}
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
				}
				.hairlineCard(padding: 14)
				.accessibilityElement(children: .ignore)
				.accessibilityLabel("Occurrences, last 24 hours, peak \(Format.count(peak)) an hour")
			}
		}
	}
}

// MARK: - Stack trace

/// The issue carries its top frame only, so this is a one-frame trace:
/// function bold, location muted.
private struct IssueStackTrace: View {
	let topFrame: String

	var body: some View {
		let frame = StackFrame(topFrame)
		if !topFrame.isEmpty {
			TitledSection(SectionHeader(title: "Stack trace", note: "Top frame")) {
				VStack(alignment: .leading, spacing: 3) {
					Text(frame.function ?? frame.location)
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(2)
					if frame.function != nil {
						Text(frame.location)
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(2)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.hairlineCard(padding: 14)
			}
		}
	}
}

/// `at fn (file:line)` or `fn (file:line)` split into its function and
/// location; anything else is a bare location.
struct StackFrame {
	let function: String?
	let location: String

	init(_ raw: String) {
		var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		if text.hasPrefix("at ") { text.removeFirst(3) }
		if text.hasSuffix(")"), let open = text.lastIndex(of: "("), open > text.startIndex {
			let name = text[..<open].trimmingCharacters(in: .whitespaces)
			let location = text[text.index(after: open)..<text.index(before: text.endIndex)]
			function = name.isEmpty ? nil : name
			self.location = String(location)
		} else {
			function = nil
			location = text
		}
	}
}

// MARK: - Sample traces

private struct IssueSamples: View {
	let samples: [ErrorIssueSampleTrace]

	var body: some View {
		if !samples.isEmpty {
			TitledSection(SectionHeader(title: "Sample traces", note: "All \(samples.count)")) {
				VStack(spacing: 0) {
					ForEach(samples, id: \.traceId) { sample in
						NavigationLink(value: Route.trace(id: sample.traceId, spanId: sample.spanId)) {
							SampleRow(sample: sample)
						}
						.buttonStyle(RowButtonStyle())
						if sample.traceId != samples.last?.traceId { Hairline() }
					}
				}
				.hairlineCard()
			}
		}
	}
}

/// The response names the trace's service, not its root span, so the service
/// leads the row.
private struct SampleRow: View {
	let sample: ErrorIssueSampleTrace

	private var durationMs: Double { sample.durationMicros / 1000 }

	var body: some View {
		HStack(spacing: 10) {
			Circle().fill(Token.destructive).frame(width: 6, height: 6)
			VStack(alignment: .leading, spacing: 3) {
				Text(sample.serviceName)
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text("\(sample.traceId.prefix(8)) · \(IssueFormat.ago(sample.timestamp))")
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
			Spacer(minLength: 8)
			Text(Format.latency(durationMs))
				.font(Typo.small)
				.tabularNumbers()
				// Past half a second a failing request was also a slow one.
				.foregroundStyle(durationMs >= 500 ? Token.severityWarn : Token.mutedForeground)
			PixelIcon.chevronRight.image
				.resizable()
				.frame(width: 12, height: 12)
				.foregroundStyle(Token.mutedForeground)
		}
		.padding(.horizontal, 14)
		.padding(.vertical, 11)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}

// MARK: - Incidents

private struct IssueIncidents: View {
	let incidents: [ErrorIncident]

	var body: some View {
		if !incidents.isEmpty {
			TitledSection(SectionHeader(title: "Incidents")) {
				VStack(spacing: 0) {
					ForEach(incidents, id: \.id) { incident in
						HStack(alignment: .firstTextBaseline) {
							VStack(alignment: .leading, spacing: 3) {
								Text(incident.status == .open ? "Open" : "Resolved")
									.font(Typo.smallMedium)
									.foregroundStyle(
										incident.status == .open ? Token.destructive : Token.mutedForeground
									)
								Text(subtitle(for: incident))
									.font(Typo.tiny)
									.foregroundStyle(Token.mutedForeground)
							}
							Spacer()
							Text(IssueFormat.ago(incident.lastTriggeredAt))
								.font(Typo.tiny)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
						.padding(.horizontal, 14)
						.padding(.vertical, 10)
						if incident.id != incidents.last?.id { Hairline() }
					}
				}
				.hairlineCard()
			}
		}
	}

	private func subtitle(for incident: ErrorIncident) -> String {
		let reason = incident.reason.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
		return "\(reason) · \(Format.count(incident.occurrenceCount)) events"
	}
}

// MARK: - Action bar

/// Pinned above the tab bar. Resolve (or Reopen) is the screen's one amber.
struct IssueActionBar: View {
	let issue: ErrorIssueDetail
	let pending: IssueAction?
	let perform: (IssueAction) -> Void

	private var isClosed: Bool { issue.workflowState.isClosed }
	private var claimed: Bool { issue.claimedAt != nil }

	var body: some View {
		HStack(spacing: 8) {
			if isClosed {
				button("Reopen", icon: nil, action: .reopen, primary: true)
			} else {
				button("Resolve", icon: .circleCheck, action: .resolve, primary: true)
			}
			button(claimed ? "Release" : "Assign", icon: .user, action: claimed ? .release : .claim, primary: false)
			if !isClosed {
				button("Ignore", icon: nil, action: .ignore, primary: false)
			}
		}
		.disabled(pending != nil)
		.padding(8)
		.hairlineCard()
		.padding(.horizontal, 16)
		.padding(.bottom, 8)
	}

	private func button(_ title: String, icon: PixelIcon?, action: IssueAction, primary: Bool) -> some View {
		Button { perform(action) } label: {
			HStack(spacing: 6) {
				if let icon {
					icon.image.resizable().frame(width: 14, height: 14)
				}
				Text(pending == action ? "\(title)…" : title)
					.font(Typo.smallMedium)
			}
			.foregroundStyle(primary ? Token.primaryForeground : Token.foreground)
			.frame(maxWidth: primary ? .infinity : nil)
			.padding(.horizontal, primary ? 0 : 14)
			.frame(height: 40)
			.background(primary ? Token.primary : Token.background, in: .rect(cornerRadius: Token.Radius.md))
			.overlay {
				if !primary {
					RoundedRectangle(cornerRadius: Token.Radius.md)
						.stroke(Token.border, lineWidth: Token.hairline)
				}
			}
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.accessibilityLabel(title)
	}
}
