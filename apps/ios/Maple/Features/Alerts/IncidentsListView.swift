import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IncidentsListModel {
	/// Which incidents the list holds.
	enum Filter: Hashable {
		/// Open only: the hub is for triage, and history is one tap away.
		case open
		/// Open incidents an escalation step paged this person for.
		case pagedToMe
		/// Open first, then the resolved ones.
		case all
	}

	private(set) var loader: ScreenLoader<[IncidentCard]>!
	private(set) var isLoadingMore = false
	let responder: IncidentResponder

	var filter: Filter = .open {
		didSet { if filter != oldValue { Task { await loader.load(.replace) } } }
	}

	private var nextCursor: String?
	private var hasMore = false
	private var rules: [String: AlertRule] = [:]
	/// Ids of the open incidents that paged this person. Read with every first
	/// page, so a later page of the list is marked from the same answer.
	private var pagingMe: Set<String> = []

	private let api: any MapleAPI
	/// One read, no paging: this many open incidents paging one person at once
	/// is past the point where a list helps.
	private static let pagingLimit = 100

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.responder = IncidentResponder(api: api, surface: .triage)
		self.loader = ScreenLoader(session: session, screen: Screen.incidents, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetchFirstPage() }
	}

	var state: LoadState<[IncidentCard]> { loader.state }

	private var status: AlertIncidentStatus? { filter == .all ? nil : .open }

	private func fetchFirstPage() async throws -> [IncidentCard] {
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)
		// Decoration in the failure sense: without it the rows still list, they
		// just do not lead with what is paging this person.
		async let pagingTask = api.alertIncidentsPagingMe(limit: Self.pagingLimit)
		let filter = self.filter
		let page: Page<AlertIncident>? =
			filter == .pagedToMe ? nil : try await api.alertIncidents(status: status, ruleId: nil, limit: 30, cursor: nil)
		rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)
		let paging: [AlertIncident]
		if filter == .pagedToMe {
			// This filter *is* the read, so its failure is the screen's.
			paging = try await pagingTask
		} else {
			paging = (try? await pagingTask) ?? []
		}
		pagingMe = Set(paging.map(\.id))
		nextCursor = page?.nextCursor
		hasMore = page?.hasMore ?? false
		guard let page else { return paging.map(card) }
		// A page to this person leads even when the list is long enough that it
		// would have arrived on a later page; that page skips it when it comes.
		let listed = Set(page.items.map(\.id))
		return (paging.filter { !listed.contains($0.id) } + page.items).map(card)
	}

	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, state.value != nil else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		let generation = loader.generation
		guard
			let page = try? await api.alertIncidents(status: status, ruleId: nil, limit: 30, cursor: cursor)
		else {
			if generation == loader.generation { hasMore = false }
			return
		}
		guard generation == loader.generation else { return }
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		loader.update(ifGeneration: generation) { cards in
			let shown = Set(cards.map(\.id))
			return cards + page.items.filter { !shown.contains($0.id) }.map(card)
		}
	}

	var canLoadMore: Bool { hasMore }

	/// Acknowledge from the row: the row changes as soon as the server answers.
	func acknowledge(_ incidentId: String) async {
		await responder.perform(.acknowledge, on: incidentId, in: loader) { cards, incident in
			guard let index = cards.firstIndex(where: { $0.id == incidentId }) else { return }
			cards[index].incident = incident
		}
	}

	private func card(_ incident: AlertIncident) -> IncidentCard {
		let rule = rules[incident.ruleId]
		return IncidentCard(
			incident: incident,
			serviceNames: rule?.serviceNames ?? [],
			display: rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType),
			observations: [],
			pagesViewer: pagingMe.contains(incident.id)
		)
	}
}

struct IncidentsListView: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: IncidentsListModel

	@Environment(SessionController.self) private var session

	private struct RowSection: Identifiable {
		let id: String
		let title: String
		let cards: [IncidentCard]
	}

	/// Pages to this person lead; what is open for everyone else follows, and
	/// history comes last. A section with nothing in it is not drawn.
	private func sections(_ cards: [IncidentCard]) -> [RowSection] {
		let open = cards.filter { $0.incident.status == .open }
		return [
			RowSection(id: "paged", title: "Paged to you", cards: open.filter(\.pagesViewer)),
			RowSection(
				id: "open",
				title: open.contains(where: \.pagesViewer) ? "Other open" : "Open alerts",
				cards: open.filter { !$0.pagesViewer }
			),
			RowSection(id: "resolved", title: "Resolved", cards: cards.filter { $0.incident.status != .open }),
		].filter { !$0.cards.isEmpty }
	}

	private var empty: (title: String, message: String) {
		switch model.filter {
		case .open: ("No open alerts", "Every alert rule is within its threshold.")
		case .pagedToMe: ("Nothing is paging you", "No open incident has paged you.")
		case .all: ("No incidents", "No alert rule has fired yet.")
		}
	}

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: empty.title,
			emptyMessage: empty.message,
			skeletonRowHeight: 84,
			header: {
				FilterChipBar {
					FilterChip(title: "Open", isOn: model.filter == .open) { model.filter = .open }
					FilterChip(title: "Paged to you", isOn: model.filter == .pagedToMe) { model.filter = .pagedToMe }
					FilterChip(title: "All", isOn: model.filter == .all) { model.filter = .all }
				}
			}
		) { cards in
			let groups = sections(cards)
			VStack(spacing: 0) {
				ForEach(groups) { section in
					let isLast = section.id == groups.last?.id
					ListCard(
						title: section.title,
						count: "\(section.cards.count)\(isLast && model.canLoadMore ? "+" : "")"
					) {
						ForEach(section.cards) { card in
							row(card)
							if card.id != section.cards.last?.id || (isLast && model.canLoadMore) { Hairline() }
						}
						if isLast, model.canLoadMore {
							// Keyed on the load, so the next page is asked for again after
							// a reload put the first page back under the same skeleton.
							SkeletonList(rowHeight: 84, rows: 1)
								.task(id: model.loader.generation) { await model.loadMore() }
						}
					}
				}
			}
		}
		.incidentActionAlert(model.responder)
		.task { await model.loader.loadIfNeeded() }
		// Answered on the incident screen, on Overview or from a banner: the rows
		// here must not go on saying it is waiting. Runs on appear too, for an
		// answer given while another segment was showing.
		.task(id: IncidentChanges.shared.revision) {
			await model.responder.reloadIfAnswered(model.loader)
		}
		.mapleScreen(Screen.incidents)
	}

	/// The row opens the incident; a page still waiting on this person carries
	/// its Acknowledge under it, outside the link so the two taps cannot blur.
	private func row(_ card: IncidentCard) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			NavigationLink(value: Route.incident(id: card.id)) {
				IncidentRow(card: card, viewerUserId: session.currentUserId)
			}
			.buttonStyle(RowButtonStyle())
			if card.needsViewer {
				HStack {
					Spacer(minLength: 0)
					AcknowledgeButton(
						ruleName: card.incident.ruleName,
						isPending: model.responder.isPending(.acknowledge, on: card.id),
						isBusy: model.responder.pending != nil
					) {
						Task { await model.acknowledge(card.id) }
					}
				}
				.padding(.horizontal, 14)
				.padding(.bottom, 12)
			}
		}
		.severityRail(card.incident.status == .open ? card.incident.severity.tint : nil)
	}
}

/// Rule name and severity, the breach, service and age, then who has it. The
/// list draws the severity rail, over this and the Acknowledge under it.
struct IncidentRow: View {
	let card: IncidentCard
	let viewerUserId: String?

	private var incident: AlertIncident { card.incident }
	private var isOpen: Bool { incident.status == .open }
	private var tint: Color { isOpen ? incident.severity.tint : Token.mutedForeground }

	var body: some View {
		SeverityRailRow(tint: nil) {
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
							: "resolved \(Format.ago(incident.resolvedAt ?? incident.lastTriggeredAt))"
					)
					.fixedSize()
					Spacer(minLength: 0)
				}
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)

				if let line = incident.responseLine(pagedViewer: card.pagesViewer, viewerUserId: viewerUserId) {
					Text(line)
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(card.needsViewer ? Token.foreground : Token.mutedForeground)
						.lineLimit(1)
				}
			}
		}
		.frame(minHeight: 84)
		.accessibilityElement(children: .combine)
	}
}
