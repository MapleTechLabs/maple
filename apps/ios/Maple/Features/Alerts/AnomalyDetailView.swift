import Charts
import MapleAPI
import SwiftUI

struct AnomalyDetail {
	var anomaly: AnomalyIncident
	var timeseries: AnomalyIncidentTimeseries?
	var linkedIssue: ErrorIssueDetail?
}

@MainActor
@Observable
final class AnomalyDetailModel {
	private(set) var loader: ScreenLoader<AnomalyDetail>!

	let anomalyID: String
	let generation: Int
	private let api: any MapleAPI

	init(anomalyID: String, api: any MapleAPI, session: SessionController) {
		self.anomalyID = anomalyID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.anomalyDetail) { [unowned self] in
			let anomaly = try await self.api.anomalyIncident(id: self.anomalyID)
			async let series = self.api.anomalyIncidentTimeseries(id: anomaly.id)
			async let issue: ErrorIssueDetail? = {
				guard let id = anomaly.errorIssueId else { return nil }
				return try? await self.api.issue(id: id)
			}()
			return AnomalyDetail(anomaly: anomaly, timeseries: try? await series, linkedIssue: await issue)
		}
	}

	var state: LoadState<AnomalyDetail> { loader.state }
}

struct AnomalyDetailView: View {
	let anomalyID: String

	@Environment(SessionController.self) private var session
	@State private var model: AnomalyDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Not found",
				emptyMessage: "This anomaly no longer exists.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { detail in
				AnomalyDetailContent(detail: detail)
			}
		}
		.navigationTitle("")
		.navigationBarTitleDisplayMode(.inline)
		.mapleScreen(Screen.anomalyDetail)
		.task(id: session.dataGeneration) {
			let model =
				if let model, model.generation == session.dataGeneration { model } else {
					AnomalyDetailModel(anomalyID: anomalyID, api: session.api, session: session)
				}
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

private struct AnomalyDetailContent: View {
	let detail: AnomalyDetail

	private var anomaly: AnomalyIncident { detail.anomaly }
	private var isOpen: Bool { anomaly.status == .open }
	private var unit: SignalUnit { anomaly.signalType.unit }

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			header
			TitledSection(
				SectionHeader(
					title: "What the detector saw",
					note: detail.timeseries.map { "\(Int($0.bucketSeconds / 60))m buckets" }
				)
			) {
				AnomalySignalChart(series: detail.timeseries, unit: unit, tint: isOpen ? anomaly.severity.tint : Token.mutedForeground)
			}
			.padding(.horizontal, 16)
			if let issue = detail.linkedIssue {
				TitledSection(SectionHeader(title: "Linked issue")) {
					NavigationLink(value: Route.issue(id: issue.id)) {
						VStack(alignment: .leading, spacing: 4) {
							Text(issue.displayTitle)
								.font(Typo.bodyMedium)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
							if let message = issue.displaySubtitle {
								Text(message)
									.font(Typo.tiny)
									.foregroundStyle(Token.mutedForeground)
									.lineLimit(2)
							}
							HStack(spacing: 6) {
								Text("\(Format.count(issue.occurrenceCount)) events").foregroundStyle(Token.severityError)
								Text("· first seen \(Format.ago(issue.firstSeenAt))").foregroundStyle(Token.mutedForeground)
							}
							.font(Typo.tiny)
							.tabularNumbers()
							.padding(.top, 2)
						}
						.padding(12)
						.frame(maxWidth: .infinity, alignment: .leading)
						.contentShape(.rect)
					}
					.buttonStyle(RowButtonStyle())
					.hairlineCard()
				}
				.padding(.horizontal, 16)
			}
			facts
		}
		.padding(.top, 4)
		.padding(.bottom, 24)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text("\(anomaly.signalType.label) on \(anomaly.serviceName)")
				.font(Typo.pageTitle)
				.tracking(-0.6)
				.foregroundStyle(Token.foreground)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
			HStack(spacing: 8) {
				Text("\(unit.format(anomaly.lastObservedValue)) vs \(unit.format(anomaly.baselineMedian))")
					.font(Typo.smallSemibold)
					.foregroundStyle(isOpen ? anomaly.severity.tint : Token.mutedForeground)
				Text(
					isOpen
						? "· open \(Format.duration(from: anomaly.firstTriggeredAt))"
						: "· lasted \(Format.duration(from: anomaly.firstTriggeredAt, to: anomaly.resolvedAt))"
				)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				MapleBadge(text: anomaly.severity.label, tint: isOpen ? anomaly.severity.tint : Token.mutedForeground, outlined: true)
				if !isOpen {
					MapleBadge(text: "Resolved", tint: Token.success, outlined: true)
				}
			}
			.tabularNumbers()
			NavigationLink(value: Route.service(name: anomaly.serviceName, window: .lastHour)) {
				HStack(spacing: 6) {
					ServiceDot(serviceName: anomaly.serviceName)
					Text(anomaly.serviceName)
					if !anomaly.deploymentEnv.isEmpty {
						Text("· \(anomaly.deploymentEnv)")
					}
				}
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
			}
			.buttonStyle(.plain)
		}
		.padding(.horizontal, 16)
	}

	private var facts: some View {
		TitledSection(SectionHeader(title: "Detector")) {
			VStack(spacing: 0) {
				row("Opened at", unit.format(anomaly.openedValue))
				row("Threshold", unit.format(anomaly.thresholdValue))
				row("Baseline", "\(unit.format(anomaly.baselineMedian)) ± \(unit.format(anomaly.baselineSigma))")
				if anomaly.reopenCount > 0 {
					row("Reopened", "\(Int(anomaly.reopenCount))×")
				}
				if let reason = anomaly.resolveReason {
					row("Resolved by", reason.rawValue.replacingOccurrences(of: "_", with: " "))
				}
			}
			.padding(.horizontal, 12)
			.hairlineCard()
		}
		.padding(.horizontal, 16)
	}

	@ViewBuilder
	private func row(_ label: String, _ value: String) -> some View {
		if label != "Opened at" { Hairline() }
		DetailRow(label, value).tabularNumbers().frame(minHeight: 40)
	}
}

/// The detector's series in a card: the observed line, its baseline (dotted)
/// and threshold (dashed), with a legend.
private struct AnomalySignalChart: View {
	let series: AnomalyIncidentTimeseries?
	let unit: SignalUnit
	let tint: Color

	private struct Bucket: Identifiable {
		var id: Date { date }
		let date: Date
		let value: Double
	}

	var body: some View {
		let buckets = (series?.buckets ?? []).compactMap { bucket -> Bucket? in
			ResolvedTimeWindow.parse(bucket.bucket).map { Bucket(date: $0, value: bucket.value) }
		}
		Group {
			if let series, buckets.count >= 2 {
				VStack(alignment: .leading, spacing: 12) {
					chart(series, buckets)
						.frame(height: 120)
					HStack {
						Text(Format.clock(buckets[0].date))
						Spacer()
						Text(Format.clock(buckets[buckets.count / 2].date))
						Spacer()
						Text(Format.clock(buckets[buckets.count - 1].date))
					}
					.font(Typo.micro)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					HStack(spacing: 16) {
						legend("Observed", dash: [], tint: tint)
						legend("Baseline", dash: [1, 2], tint: Token.mutedForeground)
						legend("Threshold", dash: [3, 2], tint: Token.mutedForeground)
					}
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
				}
			} else {
				Text(series == nil ? "Timeseries unavailable." : "Not enough data to chart.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.hairlineCard(padding: 12)
	}

	private func chart(_ series: AnomalyIncidentTimeseries, _ buckets: [Bucket]) -> some View {
		Chart {
			ForEach(buckets) { bucket in
				LineMark(x: .value("Time", bucket.date), y: .value("Value", bucket.value))
					.foregroundStyle(tint)
					.lineStyle(StrokeStyle(lineWidth: 1.5))
					.interpolationMethod(.monotone)
			}
			RuleMark(y: .value("Baseline", series.baselineMedian))
				.foregroundStyle(Token.mutedForeground.opacity(0.7))
				.lineStyle(StrokeStyle(lineWidth: 1, dash: [1, 2]))
			RuleMark(y: .value("Threshold", series.thresholdValue))
				.foregroundStyle(Token.mutedForeground)
				.lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
				.annotation(position: .top, alignment: .trailing) {
					Text(unit.format(series.thresholdValue))
						.font(Typo.micro)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
				}
		}
		.chartXAxis(.hidden)
		.chartYAxis(.hidden)
		.accessibilityLabel("Observed against baseline \(unit.format(series.baselineMedian)) and threshold \(unit.format(series.thresholdValue))")
	}

	private func legend(_ title: String, dash: [CGFloat], tint: Color) -> some View {
		HStack(spacing: 6) {
			Path { path in
				path.move(to: CGPoint(x: 0, y: 0.5))
				path.addLine(to: CGPoint(x: 12, y: 0.5))
			}
			.stroke(tint, style: StrokeStyle(lineWidth: 1.5, dash: dash))
			.frame(width: 12, height: 1)
			Text(title)
		}
	}
}
