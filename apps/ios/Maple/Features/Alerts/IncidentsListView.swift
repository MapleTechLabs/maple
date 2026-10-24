import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IncidentsListModel {
	private(set) var loader: ScreenLoader<[IncidentCard]>!
	private(set) var isLoadingMore = false

	/// Open only by default: the hub is for triage, and history is one tap
	/// away. Resolved incidents are still listed after the open ones when
	/// the filter is off.
	var openOnly = true {
		didSet { if openOnly != oldValue { Task { await loader.load(.replace) } } }
	}

	private var nextCursor: String?
	private var hasMore = false
	private var rules: [String: AlertRule] = [:]

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.loader = ScreenLoader(session: session, screen: Screen.incidents, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetchFirstPage() }
	}

	var state: LoadState<[IncidentCard]> { loader.state }

	private func fetchFirstPage() async throws -> [IncidentCard] {
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)
		let page = try await api.alertIncidents(
			status: openOnly ? .open : nil, ruleId: nil, limit: 30, cursor: nil
		)
		rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		return page.items.map(card)
	}

	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, state.value != nil else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		let generation = loader.generation
		guard
			let page = try? await api.alertIncidents(
				status: openOnly ? .open : nil, ruleId: nil, limit: 30, cursor: cursor
			)
		else {
			if generation == loader.generation { hasMore = false }
			return
		}
		guard generation == loader.generation else { return }
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		loader.update(ifGeneration: generation) { $0 + page.items.map(card) }
	}

	var canLoadMore: Bool { hasMore }

	private func card(_ incident: AlertIncident) -> IncidentCard {
		let rule = rules[incident.ruleId]
		return IncidentCard(
			incident: incident,
			serviceNames: rule?.serviceNames ?? [],
			display: rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType),
			observations: []
		)
	}
}

struct IncidentsListView: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: IncidentsListModel

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: model.openOnly ? "No open alerts" : "No incidents",
			emptyMessage: model.openOnly
				? "Every alert rule is within its threshold."
				: "No alert rule has fired yet.",
			skeletonRowHeight: 84,
			header: {
				FilterChipBar {
					FilterChip(title: "Open", isOn: model.openOnly) { model.openOnly = true }
					FilterChip(title: "All", isOn: !model.openOnly) { model.openOnly = false }
				}
			}
		) { cards in
			ListCard(
				title: model.openOnly ? "Open alerts" : "Alerts",
				count: "\(cards.count)\(model.canLoadMore ? "+" : "")"
			) {
				ForEach(cards) { card in
					NavigationLink(value: Route.incident(id: card.id)) {
						IncidentRow(card: card)
					}
					.buttonStyle(RowButtonStyle())
					if card.id != cards.last?.id || model.canLoadMore { Hairline() }
				}
				if model.canLoadMore {
					SkeletonList(rowHeight: 84, rows: 1)
						.task { await model.loadMore() }
				}
			}
		}
		.task { await model.loader.loadIfNeeded() }
		.mapleScreen(Screen.incidents)
	}
}

/// Rule name and severity, the breach, then service and age; a severity rail
/// while open.
struct IncidentRow: View {
	let card: IncidentCard

	private var incident: AlertIncident { card.incident }
	private var isOpen: Bool { incident.status == .open }
	private var tint: Color { isOpen ? incident.severity.tint : Token.mutedForeground }

	var body: some View {
		SeverityRailRow(tint: isOpen ? incident.severity.tint : nil) {
			VStack(alignment: .leading, spacing: 5) {
				HStack(spacing: 8) {
					Text(incident.ruleName)
						.font(Typo.bodyMedium)
						.foregroundStyle(isOpen ? Token.foreground : Token.mutedForeground)
						.lineLimit(1)
					MapleBadge(text: isOpen ? incident.severity.label : "Resolved", tint: isOpen ? tint : Token.success, outlined: true)
					Spacer(minLength: 0)
				}

				HStack(spacing: 6) {
					Text(card.display.label)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
					Text(incident.breach(unit: card.display.unit))
						.foregroundStyle(tint)
						.fixedSize()
				}
				.font(Typo.small)
				.tabularNumbers()

				HStack(spacing: 6) {
					if let first = card.serviceNames.first {
						ServiceDot(serviceName: first)
						Text(card.serviceNames.count > 1 ? "\(first) +\(card.serviceNames.count - 1)" : first)
							.lineLimit(1)
						Text("·")
					}
					Text(
						isOpen
							? "open \(Format.duration(from: incident.firstTriggeredAt))"
							: "resolved \(IssueFormat.ago(incident.resolvedAt ?? incident.lastTriggeredAt))"
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
