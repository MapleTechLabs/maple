import MapleAPI
import SwiftUI

@MainActor
@Observable
final class AnomaliesListModel {
	private(set) var loader: ScreenLoader<[AnomalyIncident]>!
	var openOnly = true {
		didSet { if openOnly != oldValue { Task { await loader.load(.replace) } } }
	}

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.loader = ScreenLoader(session: session, screen: Screen.anomalies, isEmpty: { $0.isEmpty }) { [unowned self] in
			try await self.api.anomalyIncidents(
				status: self.openOnly ? .open : nil,
				serviceName: nil,
				window: self.openOnly ? nil : TimeWindow.last7Days.resolve(),
				limit: 50,
				cursor: nil
			).items
		}
	}

	var state: LoadState<[AnomalyIncident]> { loader.state }
}

struct AnomaliesListView: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: AnomaliesListModel

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: model.openOnly ? "No anomalies" : "Nothing detected",
			emptyMessage: model.openOnly
				? "Every monitored signal is inside its baseline."
				: "No anomalies in the last 7 days.",
			skeletonRowHeight: 84,
			header: {
				FilterChipBar {
					FilterChip(title: "Open", isOn: model.openOnly) { model.openOnly = true }
					FilterChip(title: "Last 7 days", isOn: !model.openOnly) { model.openOnly = false }
				}
			}
		) { anomalies in
			ListCard(
				title: model.openOnly ? "Open anomalies" : "Anomalies",
				count: "\(anomalies.count)"
			) {
				ForEach(anomalies, id: \.id) { anomaly in
					NavigationLink(value: Route.anomaly(id: anomaly.id)) {
						AnomalyRow(anomaly: anomaly)
					}
					.buttonStyle(RowButtonStyle())
					if anomaly.id != anomalies.last?.id { Hairline() }
				}
			}
		}
		.task { await model.loader.loadIfNeeded() }
		.mapleScreen(Screen.anomalies)
	}
}

/// Signal and severity, observed against baseline, then service, environment
/// and age; a severity rail while open.
struct AnomalyRow: View {
	let anomaly: AnomalyIncident

	private var isOpen: Bool { anomaly.status == .open }
	private var tint: Color { isOpen ? anomaly.severity.tint : Token.mutedForeground }
	private var unit: SignalUnit { anomaly.signalType.unit }

	var body: some View {
		SeverityRailRow(tint: isOpen ? anomaly.severity.tint : nil) {
			VStack(alignment: .leading, spacing: 5) {
				HStack(spacing: 8) {
					Text(anomaly.signalType.label)
						.font(Typo.bodyMedium)
						.foregroundStyle(isOpen ? Token.foreground : Token.mutedForeground)
						.lineLimit(1)
					MapleBadge(text: isOpen ? anomaly.severity.label : "Resolved", tint: isOpen ? tint : Token.success, outlined: true)
					Spacer(minLength: 0)
				}

				HStack(spacing: 6) {
					Text(unit.format(anomaly.lastObservedValue))
						.foregroundStyle(tint)
					Text("vs baseline \(unit.format(anomaly.baselineMedian))")
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
				.font(Typo.small)
				.tabularNumbers()

				HStack(spacing: 6) {
					ServiceDot(serviceName: anomaly.serviceName)
					Text(anomaly.serviceName)
						.lineLimit(1)
					if !anomaly.deploymentEnv.isEmpty {
						Text("· \(anomaly.deploymentEnv)")
							.lineLimit(1)
					}
					Text(
						isOpen
							? "· open \(Format.duration(from: anomaly.firstTriggeredAt))"
							: "· resolved \(Format.ago(anomaly.resolvedAt ?? anomaly.lastTriggeredAt))"
					)
					.fixedSize()
					Spacer(minLength: 0)
				}
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
			}
		}
		.frame(minHeight: 84)
		.accessibilityElement(children: .combine)
	}
}
