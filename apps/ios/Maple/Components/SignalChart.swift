import Charts
import MapleAPI
import SwiftUI

/// One bucket of a service's golden signals, in the units the screen shows:
/// requests per second, a 0–1 error ratio, milliseconds.
struct SignalPoint: Identifiable, Hashable {
	let date: Date
	let throughput: Double
	let errorRate: Double
	let p50: Double
	let p95: Double
	let p99: Double
	/// Sampling-corrected requests in the bucket. What `throughput` was
	/// divided from, kept so a scrub can say "1.2K requests" as well as "/s".
	let requests: Double

	var id: Date { date }

	/// The overview's wire points as chart points. Counts become rates here,
	/// and only here, so the chart and the headline number provably carry the
	/// same unit.
	static func from(_ overview: ServiceOverview) -> [SignalPoint] {
		guard let bucketSeconds = overview.bucketSeconds, bucketSeconds > 0 else { return [] }
		let seconds = Double(bucketSeconds)
		return overview.points.compactMap { point in
			guard let date = ResolvedTimeWindow.parse(point.timestamp) else { return nil }
			let requests = point.estimatedSpanCount > 0 ? point.estimatedSpanCount : point.spanCount
			return SignalPoint(
				date: date,
				throughput: requests / seconds,
				errorRate: point.errorRate,
				p50: point.p50LatencyMs,
				p95: point.p95LatencyMs,
				p99: point.p99LatencyMs,
				requests: requests
			)
		}
	}
}

/// Which signal the chart draws. One at a time, full width — three postage
/// stamps side by side showed a shape but never a trend.
enum SignalKind: String, CaseIterable, Identifiable {
	case throughput
	case errors
	case latency

	var id: String { rawValue }

	var title: String {
		switch self {
		case .throughput: "Throughput"
		case .errors: "Errors"
		case .latency: "Latency"
		}
	}
}

extension Array where Element == SignalPoint {
	/// The bucket nearest an instant, for snapping a scrub to real data.
	func nearest(to date: Date) -> SignalPoint? {
		self.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
	}

	/// The most recent bucket that is not the still-filling one. The last
	/// bucket of a window ending now is partial, and reading it as "now" makes
	/// every service look like its traffic just fell off a cliff.
	var settled: SignalPoint? {
		count >= 2 ? self[count - 2] : last
	}
}

/// The full-width chart: an area or three lines, a leading axis in the
/// signal's own unit, and a scrub that snaps to buckets. The health breaks
/// the verdict is judged against are ruled dashed where they are in range, so
/// the line and the headline explain each other.
struct SignalChart: View {
	let points: [SignalPoint]
	let kind: SignalKind
	let window: ResolvedTimeWindow
	/// The service's own trailing p95, ruled on the latency chart when present.
	var baselineP95: Double? = nil
	/// The bucket under the finger, or nil when nobody is scrubbing.
	@Binding var scrubbed: SignalPoint?

	@State private var rawSelection: Date?

	private var peak: Double {
		switch kind {
		case .throughput: points.map(\.throughput).max() ?? 0
		case .errors: points.map(\.errorRate).max() ?? 0
		case .latency: points.map(\.p99).max() ?? 0
		}
	}

	/// Zero-anchored, with headroom so the peak never touches the top edge and
	/// a flat series still draws as a line rather than a smear on the floor.
	private var yDomain: ClosedRange<Double> {
		var top = peak
		if let baselineP95, kind == .latency { top = max(top, baselineP95) }
		if let rule = errorRule { top = max(top, rule) }
		return 0...(top > 0 ? top * 1.12 : 1)
	}

	/// The break worth drawing on the error chart: the unhealthy line once the
	/// series gets anywhere near it, the degraded line before that, nothing
	/// for a service whose errors would make either a distant ceiling.
	private var errorRule: Double? {
		guard kind == .errors else { return nil }
		if peak >= 0.025 { return 0.05 }
		if peak >= 0.005 { return 0.01 }
		return nil
	}

	private var xLabelFormat: Date.FormatStyle {
		window.end.timeIntervalSince(window.start) > 36 * 3600
			? .dateTime.weekday(.abbreviated).hour()
			: .dateTime.hour().minute()
	}

	var body: some View {
		Chart {
			switch kind {
			case .throughput:
				ForEach(points) { point in
					AreaMark(x: .value("Time", point.date), y: .value("Requests/s", point.throughput))
						.foregroundStyle(
							.linearGradient(
								colors: [Token.foreground.opacity(0.14), .clear], startPoint: .top, endPoint: .bottom
							)
						)
						.interpolationMethod(.monotone)
					LineMark(x: .value("Time", point.date), y: .value("Requests/s", point.throughput))
						.foregroundStyle(Token.foreground.opacity(0.85))
						.lineStyle(StrokeStyle(lineWidth: 1.25))
						.interpolationMethod(.monotone)
				}
			case .errors:
				ForEach(points) { point in
					AreaMark(x: .value("Time", point.date), y: .value("Error rate", point.errorRate))
						.foregroundStyle(
							.linearGradient(
								colors: [Token.chartError.opacity(0.18), .clear], startPoint: .top, endPoint: .bottom
							)
						)
						.interpolationMethod(.monotone)
					LineMark(x: .value("Time", point.date), y: .value("Error rate", point.errorRate))
						.foregroundStyle(Token.chartError)
						.lineStyle(StrokeStyle(lineWidth: 1.25))
						.interpolationMethod(.monotone)
				}
				if let errorRule {
					RuleMark(y: .value("Break", errorRule))
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
						.lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
						.annotation(position: .top, alignment: .trailing) {
							Text("\(Int((errorRule * 100).rounded()))%")
								.font(Typo.micro)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
				}
			case .latency:
				ForEach(points) { point in
					LineMark(x: .value("Time", point.date), y: .value("ms", point.p99), series: .value("Percentile", "p99"))
						.foregroundStyle(Token.chartP99.opacity(0.8))
						.lineStyle(StrokeStyle(lineWidth: 1))
						.interpolationMethod(.monotone)
					LineMark(x: .value("Time", point.date), y: .value("ms", point.p95), series: .value("Percentile", "p95"))
						.foregroundStyle(Token.chartP95)
						.lineStyle(StrokeStyle(lineWidth: 1.5))
						.interpolationMethod(.monotone)
					LineMark(x: .value("Time", point.date), y: .value("ms", point.p50), series: .value("Percentile", "p50"))
						.foregroundStyle(Token.chartP50)
						.lineStyle(StrokeStyle(lineWidth: 1))
						.interpolationMethod(.monotone)
				}
				if let baselineP95 {
					RuleMark(y: .value("Baseline", baselineP95))
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
						.lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
						.annotation(position: .top, alignment: .trailing) {
							Text("7d p95 \(Format.latency(baselineP95))")
								.font(Typo.micro)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
				}
			}

			if let scrubbed {
				RuleMark(x: .value("Selected", scrubbed.date))
					.foregroundStyle(Token.mutedForeground.opacity(0.5))
					.lineStyle(StrokeStyle(lineWidth: 1))
				switch kind {
				case .throughput:
					PointMark(x: .value("Selected", scrubbed.date), y: .value("Requests/s", scrubbed.throughput))
						.foregroundStyle(Token.foreground)
						.symbolSize(24)
				case .errors:
					PointMark(x: .value("Selected", scrubbed.date), y: .value("Error rate", scrubbed.errorRate))
						.foregroundStyle(Token.chartError)
						.symbolSize(24)
				case .latency:
					PointMark(x: .value("Selected", scrubbed.date), y: .value("ms", scrubbed.p95))
						.foregroundStyle(Token.chartP95)
						.symbolSize(24)
				}
			}
		}
		.chartXScale(domain: window.start...window.end)
		.chartYScale(domain: yDomain)
		.chartXAxis {
			// `.aligned` keeps the edge labels inside the plot instead of centring
			// the last one on the final gridline, where a 24h window's "12:00 AM"
			// was sliced to "1" even with the trailing inset below.
			AxisMarks(preset: .aligned, values: .automatic(desiredCount: 4)) { _ in
				AxisGridLine().foregroundStyle(Token.border)
				AxisValueLabel(format: xLabelFormat)
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
			}
		}
		.chartYAxis {
			AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
				AxisGridLine().foregroundStyle(Token.border)
				AxisValueLabel {
					if let number = value.as(Double.self) {
						Text(axisLabel(number))
							.font(Typo.micro)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					}
				}
			}
		}
		// See `WhatTheRuleSaw`: the trailing inset keeps the last x label whole.
		.chartPlotStyle { $0.padding(.trailing, 14) }
		.chartXSelection(value: $rawSelection)
		.onChange(of: rawSelection) { _, date in
			scrubbed = date.flatMap { points.nearest(to: $0) }
		}
		.accessibilityLabel("\(kind.title) over time")
	}

	private func axisLabel(_ value: Double) -> String {
		switch kind {
		case .throughput: value == 0 ? "0" : Format.throughput(value)
		case .errors: Format.errorRate(value)
		case .latency: value == 0 ? "0" : Format.latency(value)
		}
	}
}
