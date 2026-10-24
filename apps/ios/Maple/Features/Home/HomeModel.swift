import Foundation
import MapleAPI

/// One open incident as Home shows it: the incident, the services its rule
/// covers, and the rule's last hour of observations for the sparkline.
struct IncidentCard: Identifiable, Hashable, Codable {
	let incident: AlertIncident
	let serviceNames: [String]
	let display: SignalDisplay
	/// Observed values from the rule's own checks, oldest first. Empty until
	/// loaded, and stays empty for a rule whose checks failed to load: the
	/// card is still worth showing.
	var observations: [Double]

	var id: String { incident.id }

	static func == (lhs: IncidentCard, rhs: IncidentCard) -> Bool {
		lhs.incident == rhs.incident && lhs.observations == rhs.observations && lhs.serviceNames == rhs.serviceNames
	}

	func hash(into hasher: inout Hasher) {
		hasher.combine(incident.id)
		hasher.combine(incident.lastTriggeredAt)
	}
}

/// One service folded across its environments: counts and throughput summed,
/// error rate recomputed, p95 the worst environment's (a p95 cannot be summed).
struct ServiceSummary: Codable, Hashable {
	let name: String
	let requestCount: Double
	let errorCount: Double
	let throughput: Double
	let p95LatencyMs: Double
	/// The trailing 7-day p95 the web judges latency against, and the spans
	/// behind it. Nil when the service has no history there.
	let baselineP95LatencyMs: Double?
	let baselineSpanCount: Double?

	var errorRate: Double { requestCount > 0 ? errorCount / requestCount : 0 }

	var health: ServiceHealth {
		ServiceHealth(
			errorRate: errorRate,
			p95LatencyMs: p95LatencyMs,
			spanCount: requestCount,
			baseline: baselineP95LatencyMs.flatMap { p95 in
				baselineSpanCount.map { LatencyBaseline(p95LatencyMs: p95, spanCount: $0) }
			}
		)
	}

	/// Folds per-environment rows into one row per service, busiest first.
	static func aggregate(_ entries: [ServiceHealthEntry]) -> [ServiceSummary] {
		Dictionary(grouping: entries, by: \.serviceName).map { name, rows in
			// The worst environment's baseline goes with the worst environment's p95.
			let slowest = rows.max { $0.p95LatencyMs < $1.p95LatencyMs }
			return ServiceSummary(
				name: name,
				requestCount: rows.reduce(0) { $0 + $1.requestCount },
				errorCount: rows.reduce(0) { $0 + $1.errorCount },
				throughput: rows.reduce(0) { $0 + $1.throughput },
				p95LatencyMs: rows.map(\.p95LatencyMs).max() ?? 0,
				baselineP95LatencyMs: slowest?.baselineP95LatencyMs ?? nil,
				baselineSpanCount: slowest?.baselineSpanCount ?? nil
			)
		}
		.sorted { $0.requestCount > $1.requestCount }
	}
}

extension LatencyBaseline {
	init(p95LatencyMs: Double, spanCount: Double) {
		self.p95LatencyMs = p95LatencyMs
		self.spanCount = spanCount
	}
}

/// What Home knows about the org right now.
///
/// Codable because the last board is persisted per (org, environment) and
/// seeded on the next launch; see `SnapshotCache`.
struct HomeSnapshot: Codable {
	var services: [ServiceSummary]
	/// The equally long window before `services`, for the tiles' deltas.
	/// Nil when the API returned no comparison.
	var previousServices: [ServiceSummary]?
	var incidents: [IncidentCard]
	/// Actionable issues seen in the last 24 hours, and how many of those
	/// were first seen inside it. Second-pass data: `nil` means "still on its
	/// way", which is a different statement from 0.
	var openIssues: Int?
	var newIssues: Int?
	var openAnomalies: Int?
	var loadedAt: Date

	// MARK: Totals (the stat tiles)

	var totalRequests: Double { services.reduce(0) { $0 + $1.requestCount } }
	var errorRate: Double { Self.errorRate(services) }
	/// The slowest service's p95; there is no org-wide p95 to show. Nil with
	/// no services, where 0 would be a claim.
	var slowestP95: Double? { services.map(\.p95LatencyMs).max() }
	var previousRequests: Double? { previousServices.map { $0.reduce(0) { $0 + $1.requestCount } } }
	var previousErrorRate: Double? { previousServices.map(Self.errorRate) }
	var previousSlowestP95: Double? { previousServices.flatMap { $0.map(\.p95LatencyMs).max() } }

	/// Request-weighted, so a quiet service at 50% does not outweigh a busy one.
	private static func errorRate(_ services: [ServiceSummary]) -> Double {
		let requests = services.reduce(0) { $0 + $1.requestCount }
		guard requests > 0 else { return 0 }
		return services.reduce(0) { $0 + $1.errorCount } / requests
	}

	// MARK: Derived

	var unhealthy: [ServiceSummary] { services.filter { $0.health == .unhealthy } }
	var degraded: [ServiceSummary] { services.filter { $0.health == .degraded } }
	var criticalIncidents: [IncidentCard] { incidents.filter { $0.incident.severity == .critical } }

	/// Services that need attention, worst first: health, then error rate,
	/// then volume, the same ordering as the Services tab.
	var attention: [ServiceSummary] {
		(unhealthy + degraded).sorted { a, b in
			if a.health != b.health { return a.health == .unhealthy }
			if a.errorRate != b.errorRate { return a.errorRate > b.errorRate }
			return a.requestCount > b.requestCount
		}
	}

	/// The overall status Home leads with. Worst thing wins: a critical
	/// incident beats a degraded service, and an org that stopped sending is
	/// not healthy, it is dark.
	var status: OverallStatus {
		if services.isEmpty && incidents.isEmpty { return .noData }
		if !criticalIncidents.isEmpty || !unhealthy.isEmpty { return .critical }
		if !incidents.isEmpty || !degraded.isEmpty { return .degraded }
		return .healthy
	}

	/// The header's status line: the worst fact as the lead, the rest muted,
	/// as in `1 critical alert · 2 of 14 services degraded`.
	var statusLine: (lead: String, detail: String) {
		var parts: [String] = []
		switch status {
		case .noData:
			return ("", "No telemetry in the last hour")
		case .healthy:
			parts.append(services.count == 1 ? "Your service is healthy" : "All \(services.count) services healthy")
		case .degraded, .critical:
			let critical = criticalIncidents.count
			if critical > 0 {
				parts.append(critical == 1 ? "1 critical alert" : "\(critical) critical alerts")
			} else if !incidents.isEmpty {
				parts.append(incidents.count == 1 ? "1 open alert" : "\(incidents.count) open alerts")
			}
			// "Degraded" covers unhealthy too here, as on the web; the table's
			// health dots carry the split and the line stays one sentence.
			if !attention.isEmpty {
				parts.append("\(attention.count) of \(services.count) services degraded")
			}
		}
		if let openAnomalies, openAnomalies > 0 {
			parts.append(openAnomalies == 1 ? "1 open anomaly" : "\(openAnomalies) open anomalies")
		}
		let rest = parts.dropFirst().map { "· \($0)" }.joined(separator: " ")
		return (parts.first ?? "", rest)
	}
}

enum OverallStatus {
	case noData
	case healthy
	case degraded
	case critical
}

@MainActor
@Observable
final class HomeModel {
	private(set) var loader: ScreenLoader<HomeSnapshot>!
	/// The organization and environment this model was built for; the view
	/// builds a fresh one when either moves, so one scope's board never lingers
	/// while the next one loads.
	let scope: SessionController.DataScope

	private let api: any MapleAPI
	/// The cache key's stable half. `scope.generation` moves every sign-in, so
	/// the persisted board is keyed on the organization itself.
	private let organizationId: String?
	/// The in-flight second pass, so a new load can cancel the previous one
	/// instead of racing it.
	private var decorations: Task<Void, Never>?

	/// Home is always "now": an hour for rates, a day for what's new. There is
	/// no time picker on purpose: a picker answers "what happened", and that
	/// is a question for the other tabs.
	static let rateWindow = TimeWindow.lastHour
	static let recentWindow = TimeWindow.last24Hours

	init(api: any MapleAPI, session: SessionController, scope: SessionController.DataScope) {
		self.api = api
		self.scope = scope
		self.organizationId = session.currentOrganizationId
		self.loader = ScreenLoader(session: session, screen: Screen.home) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<HomeSnapshot> { loader.state }

	/// First appearance for this scope: paint the persisted board if there is
	/// one and revalidate it, otherwise load cold. The seeded path refreshes
	/// rather than initial-loads so the cached content stays on screen and a
	/// failure becomes the refresh strip instead of the error panel.
	func start() async {
		if !loader.state.hasContent, !loader.isLoading, let organizationId,
			let cached = SnapshotCache.load(
				HomeSnapshot.self,
				screen: Screen.home,
				organizationId: organizationId,
				environment: scope.environment
			)
		{
			loader.seed(cached)
			await loader.load(.refresh)
			return
		}
		await loader.loadIfNeeded()
	}

	/// The first pass: service health (current and previous window, as the web
	/// overview queries it) and open incidents, the screen itself. Counts and
	/// sparklines follow in a second pass.
	private func fetch() async throws -> HomeSnapshot {
		decorations?.cancel()
		let now = Date()
		let rates = Self.rateWindow.resolve(now: now)
		let recent = Self.recentWindow.resolve(now: now)

		async let healthTask = api.serviceHealth(window: rates, comparing: rates.previous)
		async let incidentsTask = api.alertIncidents(status: .open, ruleId: nil, limit: 50, cursor: nil)
		// Rules ride in the first pass: they name the incident cards. Still
		// decoration in the failure sense: a card without its rule falls back
		// to the signal type rather than taking the screen down.
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)

		let health = try await healthTask
		let previousServices = health.previous.map { ServiceSummary.aggregate($0) }
		let services = ServiceSummary.aggregate(health.services)
		let incidents = try await incidentsTask.items
		let rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)

		var cards = incidents.map { incident in
			let rule = rules[incident.ruleId]
			return IncidentCard(
				incident: incident,
				serviceNames: rule?.serviceNames ?? [],
				display: rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType),
				observations: []
			)
		}
		// Critical first, then most recently triggered.
		cards.sort { a, b in
			if a.incident.severity != b.incident.severity { return a.incident.severity == .critical }
			return a.incident.lastTriggeredAt > b.incident.lastTriggeredAt
		}

		// A refresh must not blank the numbers it already has: the previous
		// pass's counts and sparklines stay up until the new pass lands.
		let previous = loader.state.value
		let previousObservations = Dictionary(
			(previous?.incidents ?? []).map { ($0.id, $0.observations) },
			uniquingKeysWith: { first, _ in first }
		)
		for index in cards.indices {
			if let kept = previousObservations[cards[index].id] { cards[index].observations = kept }
		}

		scheduleDecorations(cards: cards, rates: rates, recent: recent)

		return HomeSnapshot(
			services: services,
			previousServices: previousServices,
			incidents: cards,
			openIssues: previous?.openIssues,
			newIssues: previous?.newIssues,
			openAnomalies: previous?.openAnomalies,
			loadedAt: now
		)
	}

	/// What the second pass produced. Counts stay `nil` on failure so the
	/// merge can tell "request failed, keep what we had" from "genuinely 0".
	private struct Decorations: Sendable {
		var openIssues: Int?
		var newIssues: Int?
		var openAnomalies: Int?
		var observations: [String: [Double]] = [:]
	}

	/// The second pass: issue counts, anomaly counts, sparklines, fetched
	/// after the board is on screen and merged into it in place.
	private func scheduleDecorations(cards: [IncidentCard], rates: ResolvedTimeWindow, recent: ResolvedTimeWindow) {
		// Captured before the task starts: if a newer load supersedes this one,
		// `update(ifGeneration:)` drops the merge on the floor.
		let generation = loader.generation
		let api = self.api
		decorations = Task { [weak self] in
			let decorations = await Telemetry.screenDecorations(
				screen: Screen.home,
				organizationId: self?.organizationId
			) {
				async let issuesTask = api.issues(
					query: IssueQuery(actionableOnly: true, sort: .lastSeen), window: recent, limit: 100, cursor: nil
				)
				async let anomaliesTask = api.anomalyIncidents(
					status: .open, serviceName: nil, window: nil, limit: 100, cursor: nil
				)
				async let observationsTask = Self.observations(for: cards, api: api, since: rates.start)

				var result = Decorations()
				if let issues = try? await issuesTask.items {
					let dayAgo = recent.start
					let newIssues = issues.filter { issue in
						guard let firstSeen = ResolvedTimeWindow.parse(issue.firstSeenAt) else { return false }
						return firstSeen >= dayAgo
					}.count
					result.openIssues = issues.count
					result.newIssues = newIssues
				}
				if let anomalies = try? await anomaliesTask.items {
					result.openAnomalies = anomalies.count
				}
				result.observations = await observationsTask
				return result
			}

			guard let self, !Task.isCancelled else { return }
			self.loader.update(ifGeneration: generation) { snapshot in
				var next = snapshot
				if let openIssues = decorations.openIssues {
					next.openIssues = openIssues
					next.newIssues = decorations.newIssues
				}
				if let openAnomalies = decorations.openAnomalies { next.openAnomalies = openAnomalies }
				for index in next.incidents.indices {
					if let values = decorations.observations[next.incidents[index].id] {
						next.incidents[index].observations = values
					}
				}
				return next
			}
			self.persist()
		}
	}

	/// One checks request per card, bounded: the first eight cards are the
	/// ones on screen; the rest get a sparkline when tapped into.
	private static func observations(
		for cards: [IncidentCard],
		api: any MapleAPI,
		since: Date
	) async -> [String: [Double]] {
		await withTaskGroup(of: (String, [Double]).self, returning: [String: [Double]].self) { group in
			for card in cards.prefix(8) {
				group.addTask {
					let checks = try? await api.alertRuleChecks(
						ruleId: card.incident.ruleId,
						groupKey: card.incident.groupKey,
						since: since,
						limit: 60
					)
					return (card.id, (checks ?? []).compactMap(\.observedValue))
				}
			}
			var result: [String: [Double]] = [:]
			for await (id, values) in group { result[id] = values }
			return result
		}
	}

	/// Write whatever the board currently shows, so the next launch can seed
	/// it. Called after the second pass merges: the fullest the board gets.
	private func persist() {
		guard let organizationId, let snapshot = loader.state.value else { return }
		SnapshotCache.save(
			snapshot,
			screen: Screen.home,
			organizationId: organizationId,
			environment: scope.environment
		)
	}
}
