import MapleAPI
import SwiftUI

// MARK: - What the rule saw

/// The rule's own evaluations as bars: breaching ones red, the rest grey,
/// under a dashed threshold line, as on the web incident page.
struct RuleSignalSection: View {
	let detail: IncidentDetail

	private var trailing: String? {
		detail.rule.map { "\($0.windowMinutes)m window · \($0.consecutiveBreachesRequired) to open" }
	}

	var body: some View {
		TitledSection(SectionHeader(title: "What the rule saw", note: trailing)) {
			let bars = Self.bars(detail.ruleSignal.points, max: 40)
			if bars.count < 2 {
				Text("Not enough evaluations to chart yet.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.frame(maxWidth: .infinity, alignment: .leading)
					.hairlineCard(padding: 12)
			} else {
				VStack(alignment: .leading, spacing: 12) {
					RuleBars(bars: bars, signal: detail.ruleSignal, unit: detail.display.unit)
						.frame(height: 120)
					axis(bars)
					legend
				}
				.hairlineCard(padding: 12)
			}
		}
		.padding(.horizontal, 16)
	}

	/// At most `max` bars: neighbouring evaluations merge into their peak, and
	/// a merged bar breaches when any of its evaluations did.
	private static func bars(_ points: [RuleSignal.Point], max: Int) -> [RuleSignal.Point] {
		guard points.count > max else { return points }
		let size = Int((Double(points.count) / Double(max)).rounded(.up))
		return stride(from: 0, to: points.count, by: size).map { start in
			let slice = points[start..<min(start + size, points.count)]
			let peak = slice.max { $0.value < $1.value } ?? slice[slice.startIndex]
			return RuleSignal.Point(date: slice[slice.startIndex].date, value: peak.value, breached: slice.contains(where: \.breached))
		}
	}

	private func axis(_ bars: [RuleSignal.Point]) -> some View {
		HStack {
			Text(Format.clock(bars[0].date))
			Spacer()
			Text(Format.clock(bars[bars.count / 2].date))
			Spacer()
			Text(Format.clock(bars[bars.count - 1].date))
		}
		.font(Typo.micro)
		.tabularNumbers()
		.foregroundStyle(Token.mutedForeground)
	}

	private var legend: some View {
		HStack(spacing: 16) {
			swatch("Breaching", Token.destructive)
			swatch("Within threshold", RuleBars.calmTint)
			HStack(spacing: 6) {
				Rectangle().fill(Token.mutedForeground).frame(width: 12, height: 1)
				Text("Threshold")
			}
		}
		.font(Typo.tiny)
		.foregroundStyle(Token.mutedForeground)
		.lineLimit(1)
		.minimumScaleFactor(0.8)
	}

	private func swatch(_ title: String, _ tint: Color) -> some View {
		HStack(spacing: 6) {
			RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 8, height: 8)
			Text(title)
		}
	}
}

private struct RuleBars: View {
	let bars: [RuleSignal.Point]
	let signal: RuleSignal
	let unit: SignalUnit

	static let calmTint = Token.mutedForeground.opacity(0.45)

	private var ceiling: Double {
		let peak = bars.map(\.value).max() ?? 0
		return Swift.max(peak, signal.threshold, signal.upper ?? 0) * 1.12
	}

	var body: some View {
		GeometryReader { proxy in
			let height = proxy.size.height
			let ceiling = Swift.max(ceiling, .leastNonzeroMagnitude)
			let gap: CGFloat = bars.count > 28 ? 2 : 5
			// The threshold label sits in its own trailing gutter, as in the design.
			let labelWidth: CGFloat = 34
			let plotWidth = proxy.size.width - labelWidth
			ZStack(alignment: .topLeading) {
				HStack(alignment: .bottom, spacing: gap) {
					ForEach(bars) { bar in
						RoundedRectangle(cornerRadius: 1.5)
							.fill(bar.breached ? Token.destructive : Self.calmTint)
							.frame(height: Swift.max(2, height * CGFloat(bar.value / ceiling)))
							.frame(maxWidth: .infinity)
					}
				}
				.frame(width: plotWidth, height: height, alignment: .bottom)

				ForEach(thresholds, id: \.self) { value in
					let y = height * CGFloat(1 - value / ceiling)
					Path { path in
						path.move(to: CGPoint(x: 0, y: y))
						path.addLine(to: CGPoint(x: plotWidth, y: y))
					}
					.stroke(Token.mutedForeground, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
					Text(unit.format(value))
						.font(Typo.micro)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
						.minimumScaleFactor(0.7)
						.frame(width: labelWidth, alignment: .trailing)
						.position(x: plotWidth + labelWidth / 2, y: y)
				}

				Rectangle()
					.fill(Token.border)
					.frame(width: plotWidth, height: Token.hairline)
					.offset(y: height - Token.hairline)
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(
			"\(bars.filter(\.breached).count) of \(bars.count) evaluations breaching, threshold \(unit.format(signal.threshold))"
		)
	}

	private var thresholds: [Double] {
		[signal.threshold] + (signal.upper.map { [$0] } ?? [])
	}
}

// MARK: - What changed

/// The service's errors, p95 and throughput over the same window, each against
/// its level before the incident opened.
struct WhatChangedSection: View {
	let detail: IncidentDetail

	private var points: [ServiceOverviewPoint] { detail.overview?.points ?? [] }

	var body: some View {
		TitledSection(SectionHeader(title: "What changed on \(detail.serviceName ?? "the service")")) {
			let opened = ResolvedTimeWindow.parse(detail.incident.firstTriggeredAt) ?? Date()
			let split = points.firstIndex { (ResolvedTimeWindow.parse($0.timestamp) ?? .distantPast) >= opened }
			let bucket = Double(detail.overview?.bucketSeconds ?? 60)
			let errors = Change(values: points.map(\.errorRate), split: split)
			let p95 = Change(values: points.map(\.p95LatencyMs), split: split)
			let rps = Change(values: points.map { $0.spanCount / bucket }, split: split)
			StatGrid(columns: 3) {
				ChangeTile(
					label: "Errors",
					value: SignalUnit.ratio.format(errors.current),
					values: errors.values,
					tint: Token.chartError,
					delta: errors.pointsDelta
				)
				ChangeTile(
					label: "P95",
					value: SignalUnit.milliseconds.format(p95.current),
					values: p95.values,
					tint: Token.chartP95,
					delta: p95.ratioDelta
				)
				ChangeTile(
					label: "Throughput",
					value: rps.current.map(Format.throughput) ?? SignalUnit.plain.format(nil),
					values: rps.values,
					tint: Token.mutedForeground,
					delta: rps.percentDelta
				)
			}
		}
		.padding(.horizontal, 16)
	}
}

/// A series split at the incident's open: the level before, and now.
private struct Change {
	let values: [Double]
	let baseline: Double?
	/// The last full bucket; the trailing one is usually still filling.
	let current: Double?

	init(values: [Double], split: Int?) {
		let finite = values.filter(\.isFinite)
		self.values = finite
		let before = split.map { Array(values.prefix($0)) } ?? Array(values.prefix(values.count / 3))
		let calm = before.filter(\.isFinite)
		baseline = calm.isEmpty ? nil : calm.reduce(0, +) / Double(calm.count)
		current = (finite.count > 2 ? finite.dropLast() : finite[...]).last
	}

	/// `+8.4 pts`, for a 0-1 ratio.
	var pointsDelta: (String, Color)? {
		guard let baseline, let current else { return nil }
		let points = (current - baseline) * 100
		let tint = points >= 0.5 ? Token.severityError : points <= -0.5 ? Token.severityInfo : Token.mutedForeground
		return (String(format: "%+.1f pts", points), tint)
	}

	/// `+2.1x` once it has moved by half again, a percentage below that.
	var ratioDelta: (String, Color)? {
		guard let baseline, let current, baseline > 0 else { return nil }
		let ratio = current / baseline
		let tint = ratio >= 1.2 ? Token.severityWarn : ratio <= 0.83 ? Token.severityInfo : Token.mutedForeground
		if ratio >= 1.5 { return (String(format: "+%.1fx", ratio), tint) }
		return (String(format: "%+.0f%%", (ratio - 1) * 100), tint)
	}

	/// `+3%`: traffic moving is context, so it stays muted unless it swings.
	var percentDelta: (String, Color)? {
		guard let baseline, let current, baseline > 0 else { return nil }
		let change = current / baseline - 1
		return (String(format: "%+.0f%%", change * 100), abs(change) >= 0.3 ? Token.severityWarn : Token.mutedForeground)
	}
}

private struct ChangeTile: View {
	let label: String
	let value: String
	let values: [Double]
	let tint: Color
	let delta: (String, Color)?

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(label)
				.font(Typo.micro)
				.tracking(0.55)
				.textCase(.uppercase)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
			Text(value)
				.font(Typo.bodyMedium)
				.tabularNumbers()
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
				.minimumScaleFactor(0.7)
			Sparkline(values: values, tint: tint, fills: false, anchorsToZero: false)
				.frame(height: 24)
			Text(delta?.0 ?? " ")
				.font(Typo.micro)
				.tabularNumbers()
				.foregroundStyle(delta?.1 ?? Token.mutedForeground)
				.lineLimit(1)
		}
		.padding(10)
		.frame(maxWidth: .infinity, alignment: .leading)
		.hairlineCard()
		.accessibilityElement(children: .combine)
	}
}

// MARK: - Likely cause

/// The linked issue (or the window's top issue), then the operations failing
/// most in the window, in one card.
struct LikelyCauseSection: View {
	let detail: IncidentDetail

	var body: some View {
		TitledSection(SectionHeader(title: "Likely cause")) {
			if detail.linkedIssue == nil, detail.topIssue == nil, detail.failingOperations.isEmpty {
				Text(
					detail.serviceName == nil
						? "This rule spans several services, so there is no single service to correlate."
						: "No error issues or failing operations in the window."
				)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)
			} else {
				VStack(spacing: 0) {
					if let issue = detail.linkedIssue {
						issueRow(
							kicker: "Linked issue", id: issue.id, title: issue.displayTitle, message: issue.displaySubtitle,
							count: issue.occurrenceCount, firstSeen: issue.firstSeenAt
						)
					} else if let issue = detail.topIssue {
						issueRow(
							kicker: "Top error in window", id: issue.id, title: issue.displayTitle, message: issue.displaySubtitle,
							count: issue.occurrenceCount, firstSeen: issue.firstSeenAt
						)
					}
					if !detail.failingOperations.isEmpty {
						if detail.linkedIssue != nil || detail.topIssue != nil { Hairline() }
						operations
					}
				}
				.hairlineCard()
			}
		}
		.padding(.horizontal, 16)
	}

	private func issueRow(
		kicker: String, id: String, title: String, message: String?, count: Double, firstSeen: String
	) -> some View {
		NavigationLink(value: Route.issue(id: id)) {
			VStack(alignment: .leading, spacing: 4) {
				Text(kicker)
					.font(Typo.micro)
					.tracking(0.55)
					.textCase(.uppercase)
					.foregroundStyle(Token.mutedForeground)
				Text(title)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				if let message {
					Text(message)
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(2)
				}
				HStack(spacing: 6) {
					Text("\(Format.count(count)) events").foregroundStyle(Token.severityError)
					Text("· first seen \(IssueFormat.ago(firstSeen))").foregroundStyle(Token.mutedForeground)
				}
				.font(Typo.tiny)
				.tabularNumbers()
				.lineLimit(1)
				.padding(.top, 2)
			}
			.padding(12)
			.frame(maxWidth: .infinity, alignment: .leading)
			.contentShape(.rect)
		}
		.buttonStyle(RowButtonStyle())
	}

	private var operations: some View {
		VStack(spacing: 0) {
			HStack {
				Text("Failing operation")
				Spacer(minLength: 8)
				Text("Failures")
			}
			.font(Typo.micro)
			.tracking(0.55)
			.textCase(.uppercase)
			.foregroundStyle(Token.mutedForeground)
			.padding(.horizontal, 12)
			.frame(height: 32)
			ForEach(Array(detail.failingOperations.enumerated()), id: \.offset) { _, item in
				Hairline()
				HStack(spacing: 8) {
					Text(item.name.isEmpty ? "(unnamed)" : item.name)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
						.truncationMode(.middle)
					Spacer(minLength: 8)
					Text(Format.count(item.value))
						.tabularNumbers()
						.foregroundStyle(Token.destructive)
				}
				.font(Typo.small)
				.padding(.horizontal, 12)
				.frame(height: 40)
			}
		}
	}
}

// MARK: - Timeline

/// Triggered, notified, renotified, resolved: a vertical rail of what happened
/// and where each notification went.
struct IncidentTimeline: View {
	let detail: IncidentDetail

	private struct Event: Identifiable {
		let id: String
		let at: String
		let title: String
		let detail: String?
		var detailTint: Color = Token.mutedForeground
		let dot: Color
	}

	private var events: [Event] {
		let incident = detail.incident
		let unit = detail.display.unit
		var events: [Event] = []
		let checks = detail.rule.map { ", \($0.consecutiveBreachesRequired) of \($0.consecutiveBreachesRequired) checks" } ?? ""
		events.append(
			Event(
				id: "triggered",
				at: incident.firstTriggeredAt,
				title: "Triggered",
				detail: "\(detail.display.label.lowercased()) \(incident.comparator.glyph) \(unit.format(incident.threshold))\(checks)",
				dot: incident.severity.tint
			)
		)

		let trigger = detail.deliveries.filter { $0.eventType == .trigger }
		if let first = trigger.first {
			let failed = trigger.filter { $0.status == .failed }
			let others = trigger.count - 1
			events.append(
				Event(
					id: "notified",
					at: first.attemptedAt ?? first.scheduledAt,
					title: "Notified \(first.destinationName)",
					detail: failed.first.map { "\($0.destinationName) failed: \($0.errorMessage ?? "no response")" }
						?? (others > 0 ? "and \(others) more" : first.destinationType.label),
					detailTint: failed.isEmpty ? Token.mutedForeground : Token.destructive,
					dot: Token.mutedForeground
				)
			)
		}

		for delivery in detail.deliveries where delivery.eventType == .renotify {
			events.append(
				Event(
					id: delivery.id,
					at: delivery.attemptedAt ?? delivery.scheduledAt,
					title: "Renotified",
					detail: delivery.status == .failed
						? "\(delivery.destinationName) failed: \(delivery.errorMessage ?? "no response")"
						: "still breaching · \(delivery.destinationName)",
					detailTint: delivery.status == .failed ? Token.destructive : Token.mutedForeground,
					dot: Token.mutedForeground
				)
			)
		}

		if let resolved = incident.resolvedAt {
			let sent = detail.deliveries.filter { $0.eventType == .resolve }.map(\.destinationName)
			let lasted = "lasted \(Format.duration(from: incident.firstTriggeredAt, to: resolved))"
			events.append(
				Event(
					id: "resolved",
					at: resolved,
					title: "Resolved",
					detail: sent.isEmpty ? lasted : "\(lasted) · \(sent.joined(separator: ", "))",
					dot: Token.success
				)
			)
		}
		return events.sorted { $0.at < $1.at }
	}

	var body: some View {
		TitledSection(SectionHeader(title: "Timeline")) {
			VStack(alignment: .leading, spacing: 16) {
				ForEach(events) { event in
					HStack(alignment: .firstTextBaseline, spacing: 12) {
						Text(Format.timelineClock(event.at))
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
							.fixedSize()
							.frame(minWidth: 40, alignment: .leading)
						VStack(alignment: .leading, spacing: 2) {
							Text(event.title)
								.font(Typo.body)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
							if let text = event.detail {
								Text(text)
									.font(Typo.tiny)
									.foregroundStyle(event.detailTint)
									.lineLimit(2)
							}
						}
						Spacer(minLength: 0)
					}
					.overlay(alignment: .topLeading) {
						Circle()
							.fill(event.dot)
							.frame(width: 7, height: 7)
							.offset(x: -20, y: 5)
					}
					.accessibilityElement(children: .combine)
				}
				if detail.deliveries.isEmpty {
					Text("No notifications were sent for this incident.")
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
				}
			}
			.padding(.leading, 20)
			.padding(.vertical, 4)
			.background(alignment: .leading) {
				Rectangle()
					.fill(Token.border)
					.frame(width: 1)
					.padding(.vertical, 8)
					.offset(x: 3)
			}
		}
		.padding(.horizontal, 16)
	}
}
