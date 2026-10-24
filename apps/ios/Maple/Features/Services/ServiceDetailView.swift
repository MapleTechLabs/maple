import MapleAPI
import SwiftUI

/// What the service screen knows. Codable because the last board for a
/// (service, window) is persisted and seeded on the next visit — see
/// `SnapshotCache`.
struct ServiceDetail: Codable {
	/// The one read that paints the screen: summary, per-bucket signals,
	/// busiest operations.
	var overview: ServiceOverview
	/// Open incidents whose rule names this service (or is grouped on it).
	/// Second-pass data, merged in once the screen is up.
	var incidents: [IncidentCard]
	var issues: [ErrorIssue]
	var loadedAt: Date

	var service: Service { overview.service }
}

@MainActor
@Observable
final class ServiceDetailModel {
	private(set) var loader: ScreenLoader<ServiceDetail>!

	let serviceName: String
	var window: TimeWindow
	/// The organization and environment this model answers for; the view
	/// rebuilds it when either moves.
	let scope: SessionController.DataScope

	private let api: any MapleAPI
	/// The cache key's stable half — `scope.generation` moves every sign-in.
	private let organizationId: String?
	/// The in-flight second pass, so a new load cancels it rather than racing.
	private var decorations: Task<Void, Never>?

	init(
		serviceName: String,
		window: TimeWindow,
		api: any MapleAPI,
		session: SessionController,
		scope: SessionController.DataScope
	) {
		self.serviceName = serviceName
		self.window = window
		self.api = api
		self.scope = scope
		self.organizationId = session.currentOrganizationId
		self.loader = ScreenLoader(session: session, screen: Screen.serviceDetail) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<ServiceDetail> { loader.state }

	/// First appearance for this scope: paint the last board for this service
	/// and window if there is one and revalidate, otherwise load cold.
	func start() async {
		if !loader.state.hasContent, !loader.isLoading, let organizationId,
			let cached = SnapshotCache.load(
				ServiceDetail.self,
				screen: cacheScreen,
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

	/// One snapshot per (service, window): a cached day must not seed an hour.
	private var cacheScreen: String { "\(Screen.serviceDetail):\(serviceName):\(window.rawValue)" }

	/// The first pass is one request. The overview *is* the screen — the
	/// `screen.load` span measures time-to-content — and alerts and issues are
	/// context that lands a moment later without gating the paint.
	private func fetch() async throws -> ServiceDetail {
		decorations?.cancel()
		let now = Date()
		let resolved = window.resolve(now: now)
		let overview = try await api.serviceOverview(ServiceOverviewRequest(serviceName: serviceName, window: resolved))

		// A refresh must not blank the rows it already has: the previous pass's
		// alerts and issues stay until the new pass lands.
		let previous = loader.state.value
		scheduleDecorations(window: resolved)
		return ServiceDetail(
			overview: overview,
			incidents: previous?.incidents ?? [],
			issues: previous?.issues ?? [],
			loadedAt: now
		)
	}

	private struct Decorations: Sendable {
		var incidents: [IncidentCard]?
		var issues: [ErrorIssue]?
	}

	/// The second pass: this service's open alerts and issues, fetched after
	/// the board is on screen and merged into it in place. Rules are only
	/// read when there is an incident to name.
	private func scheduleDecorations(window: ResolvedTimeWindow) {
		let generation = loader.generation
		let api = self.api
		let name = serviceName
		decorations = Task { [weak self] in
			let decorations = await Telemetry.screenDecorations(
				screen: Screen.serviceDetail,
				organizationId: self?.organizationId
			) {
				async let issuesTask = api.issues(
					query: IssueQuery(serviceName: name, actionableOnly: true), window: window, limit: 10, cursor: nil
				)
				async let incidentsTask = Self.incidents(for: name, api: api)
				var result = Decorations()
				if let issues = try? await issuesTask.items { result.issues = issues }
				result.incidents = await incidentsTask
				return result
			}

			guard let self, !Task.isCancelled else { return }
			self.loader.update(ifGeneration: generation) { detail in
				var next = detail
				if let incidents = decorations.incidents { next.incidents = incidents }
				if let issues = decorations.issues { next.issues = issues }
				return next
			}
			self.persist()
		}
	}

	/// Open incidents that concern this service: scoped to it by the rule,
	/// grouped on it, or organization-wide without excluding it. Nil when the
	/// read failed, so the merge keeps what it had.
	private static func incidents(for name: String, api: any MapleAPI) async -> [IncidentCard]? {
		guard let incidents = try? await api.alertIncidents(status: .open, ruleId: nil, limit: 50, cursor: nil).items
		else { return nil }
		if incidents.isEmpty { return [] }
		let rules = Dictionary(
			((try? await api.alertRules(limit: 100, cursor: nil).items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)
		return incidents.compactMap { incident in
			guard let rule = rules[incident.ruleId] else { return nil }
			let scoped = rule.serviceNames.contains(name)
			let grouped = incident.groupKey == name
			let global = rule.serviceNames.isEmpty && !rule.excludeServiceNames.contains(name) && incident.groupKey == nil
			guard scoped || grouped || global else { return nil }
			return IncidentCard(
				incident: incident, serviceNames: rule.serviceNames, display: SignalDisplay(rule: rule), observations: []
			)
		}
	}

	private func persist() {
		guard let organizationId, let detail = loader.state.value else { return }
		SnapshotCache.save(detail, screen: cacheScreen, organizationId: organizationId, environment: scope.environment)
	}
}

struct ServiceDetailView: View {
	let serviceName: String
	let window: TimeWindow

	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@Environment(\.openURL) private var openURL
	@State private var model: ServiceDetailModel?

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "No data",
				emptyMessage: "This service reported nothing in \((model?.window ?? window).phrase).",
				skeleton: { DetailSkeleton(leadsWithHeadline: true, leadsWithChart: true) }
			) { detail in
				ServiceDetailContent(detail: detail, window: model?.window ?? window)
					.id(serviceName)
			}
		}
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .principal) {
				HStack(spacing: 8) {
					ServiceDot(serviceName: serviceName, size: 8)
					Text(serviceName)
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
				}
				.accessibilityElement(children: .combine)
				.accessibilityAddTraits(.isHeader)
			}
			ToolbarItem(placement: .topBarTrailing) {
				Button {
					openURL(MapleWeb.service(serviceName))
				} label: {
					PixelIcon.externalLink.image
						.resizable()
						.frame(width: 14, height: 14)
						.foregroundStyle(Token.mutedForeground)
				}
				.accessibilityLabel("Open on web")
			}
		}
		.mapleScreen(Screen.serviceDetail)
		// Keyed on the name too: a deep link that swaps the pushed service
		// reuses this view, and must not keep the previous service's model.
		.task(id: TaskKey(scope: scope, serviceName: serviceName)) {
			let model =
				if let model, model.scope == scope, model.serviceName == serviceName { model } else {
					ServiceDetailModel(
						serviceName: serviceName,
						window: window,
						api: session.api.scoped(toEnvironment: scope.environment),
						session: session,
						scope: scope
					)
				}
			self.model = model
			await model.start()
		}
	}
}

private struct TaskKey: Hashable {
	let scope: SessionController.DataScope
	let serviceName: String
}

private enum DetailSegment: String, CaseIterable {
	case overview, operations, errors

	var title: String {
		switch self {
		case .overview: "Overview"
		case .operations: "Operations"
		case .errors: "Errors"
		}
	}
}

private struct ServiceDetailContent: View {
	let detail: ServiceDetail
	let window: TimeWindow

	@State private var segment: DetailSegment = .overview
	@State private var sort: OperationSort = .failures

	private var service: Service { detail.service }
	private var resolvedWindow: ResolvedTimeWindow {
		// The overview echoes the bounds it answered for, so the chart's axis
		// is the server's window rather than a fresh `Date()`.
		ResolvedTimeWindow(
			start: ResolvedTimeWindow.parse(detail.overview.startTime) ?? window.resolve().start,
			end: ResolvedTimeWindow.parse(detail.overview.endTime) ?? window.resolve().end
		)
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			VerdictHeadline(verdict: ServiceHealth.verdict(for: service, window: window))
				.padding(.horizontal, 16)
				.padding(.top, 12)

			UnderlineTabs(
				options: DetailSegment.allCases.map { ($0, $0.title) },
				selection: $segment
			)
			.padding(.top, 16)

			switch segment {
			case .overview: overview
			case .operations:
				OperationsSection(operations: detail.overview.operations, window: window, sort: $sort, limit: nil)
					.padding(.horizontal, 16)
					.padding(.top, 16)
			case .errors: errors
			}
		}
		.padding(.bottom, 24)
	}

	@ViewBuilder
	private var overview: some View {
		StatGrid(columns: 2) {
			StatTile(label: "Throughput", value: ServicesFormat.rps(service.throughput))
			StatTile(label: "Error rate", value: Format.errorRate(service.errorRate))
			StatTile(
				label: "P95 latency",
				value: Format.latency(service.p95LatencyMs),
				delta: StatDelta(
					current: service.p95LatencyMs,
					previous: LatencyBaseline(service: service)?.p95LatencyMs,
					higherIsBetter: false,
					style: .milliseconds,
					comparison: "vs baseline"
				)
			)
			StatTile(label: "Open issues", value: "\(detail.issues.count)", note: issuesNote)
		}
		.padding(.horizontal, 16)
		.padding(.top, 16)

		SignalCard(
			points: SignalPoint.from(detail.overview),
			window: resolvedWindow,
			windowLabel: ServicesFormat.window(window),
			baselineP95: LatencyBaseline(service: service)?.p95LatencyMs
		)
		.padding(.horizontal, 16)
		.padding(.top, 16)

		if !detail.incidents.isEmpty {
			VStack(alignment: .leading, spacing: 8) {
				ServiceSectionHeader(title: "Open alerts", count: detail.incidents.count)
				ForEach(detail.incidents) { card in
					NavigationLink(value: Route.incident(id: card.id)) {
						ServiceIncidentRow(card: card)
					}
					.buttonStyle(.plain)
				}
			}
			.padding(.horizontal, 16)
			.padding(.top, 24)
		}

		OperationsSection(operations: detail.overview.operations, window: window, sort: $sort, limit: 5)
			.padding(.horizontal, 16)
			.padding(.top, 24)
	}

	/// `1 new today`: issues first seen in the last 24 hours.
	private var issuesNote: (text: String, tint: Color)? {
		guard !detail.issues.isEmpty else { return nil }
		let dayAgo = Date().addingTimeInterval(-86_400)
		let fresh = detail.issues.filter { (ResolvedTimeWindow.parse($0.firstSeenAt) ?? .distantPast) >= dayAgo }.count
		return fresh > 0 ? ("\(fresh) new today", Token.severityWarn) : ("none new today", Token.mutedForeground)
	}

	@ViewBuilder
	private var errors: some View {
		VStack(alignment: .leading, spacing: 8) {
			ServiceSectionHeader(title: "Open issues", count: detail.issues.isEmpty ? nil : detail.issues.count)
			if detail.issues.isEmpty {
				Text("Nothing needs attention in \(window.phrase).")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.padding(.top, 4)
			} else {
				VStack(spacing: 0) {
					ForEach(Array(detail.issues.enumerated()), id: \.element.id) { index, issue in
						NavigationLink(value: Route.issue(id: issue.id)) {
							IssueRow(issue: issue, showsService: false)
						}
						.buttonStyle(RowButtonStyle())
						if index < detail.issues.count - 1 { Hairline() }
					}
				}
				.background(Token.card)
				.clipShape(.rect(cornerRadius: Token.Radius.lg))
				.overlay(
					RoundedRectangle(cornerRadius: Token.Radius.lg)
						.stroke(Token.border, lineWidth: Token.hairline)
				)
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 16)
	}
}

/// The verdict and the sentence behind it, the only place on the screen the
/// health colour is allowed to be loud, as on Home.
private struct VerdictHeadline: View {
	let verdict: ServiceHealth.Verdict

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 8) {
				Circle()
					.fill(verdict.health.tint)
					.frame(width: 8, height: 8)
				Text(verdict.title)
					.font(Typo.title)
					.tracking(-0.5)
					.foregroundStyle(Token.foreground)
			}
			Text(verdict.reason)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)
		}
		.accessibilityElement(children: .combine)
	}
}

/// One signal at a time, full width. The headline is the latest settled
/// bucket (what the service is doing now) with the window's peak beside it;
/// scrubbing swaps it for the bucket under the finger.
private struct SignalCard: View {
	let points: [SignalPoint]
	let window: ResolvedTimeWindow
	let windowLabel: String
	let baselineP95: Double?

	@State private var kind: SignalKind = .throughput
	@State private var scrubbed: SignalPoint?

	private var shown: SignalPoint? { scrubbed ?? points.settled }

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			HStack {
				SegmentChips(
					options: SignalKind.allCases.map { ($0, $0.title) },
					selection: Binding(
						get: { kind },
						set: { next in
							kind = next
							scrubbed = nil
							Telemetry.track(Telemetry.Event.serviceSignalChanged, ["signal": next.rawValue])
						}
					),
					style: .framedCompact
				)
				Spacer(minLength: 8)
				Text("last \(windowLabel)")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
			}

			if points.count < 2 {
				Text("Not enough traffic in this window to chart.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.frame(height: 130)
					.frame(maxWidth: .infinity)
			} else {
				readout
				SignalChart(
					points: points,
					kind: kind,
					window: window,
					baselineP95: baselineP95,
					scrubbed: $scrubbed,
					axisLabels: false
				)
				.frame(height: 130)
				legend
			}
		}
		.padding(12)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
	}

	/// `612 ms  p95 now · peak 702 ms`, or the scrubbed bucket's time.
	private var readout: some View {
		let when = scrubbed.map { $0.date.formatted(date: .omitted, time: .shortened) } ?? "now"
		let value: String
		let detail: String
		switch kind {
		case .throughput:
			value = ServicesFormat.rps(shown?.throughput ?? 0)
			detail = "\(when) · peak \(ServicesFormat.rps(points.map(\.throughput).max() ?? 0))"
		case .errors:
			value = Format.errorRate(shown?.errorRate ?? 0)
			detail = "\(when) · peak \(Format.errorRate(points.map(\.errorRate).max() ?? 0))"
		case .latency:
			value = Format.latency(shown?.p95 ?? 0)
			detail = "p95 \(when) · peak \(Format.latency(points.map(\.p95).max() ?? 0))"
		}
		return HStack(alignment: .firstTextBaseline, spacing: 8) {
			Text(value)
				.font(Typo.statValue)
				.tracking(-0.4)
				.tabularNumbers()
				.foregroundStyle(Token.foreground)
			Text(detail)
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
		}
		.animation(nil, value: scrubbed)
		.accessibilityElement(children: .combine)
	}

	/// Swatches with the shown bucket's values, and the unit on the right.
	private var legend: some View {
		HStack(spacing: 12) {
			switch kind {
			case .throughput:
				LegendItem(tint: Token.foreground.opacity(0.85), text: "throughput")
			case .errors:
				LegendItem(tint: Token.chartError, text: "error rate")
			case .latency:
				LegendItem(tint: Token.chartP50, text: "p50 \(Self.ms(shown?.p50))")
				LegendItem(tint: Token.chartP95, text: "p95 \(Self.ms(shown?.p95))")
				LegendItem(tint: Token.chartP99, text: "p99 \(Self.ms(shown?.p99))")
			}
			Spacer(minLength: 0)
			Text(unit)
				.font(Typo.micro)
				.foregroundStyle(Token.mutedForeground)
		}
	}

	private var unit: String {
		switch kind {
		case .throughput: "rps"
		case .errors: "%"
		case .latency: "ms"
		}
	}

	/// Whole milliseconds, unit-less: the legend's unit sits on the right.
	private static func ms(_ value: Double?) -> String {
		guard let value, value.isFinite else { return "-" }
		return "\(Int(value.rounded()))"
	}

	private struct LegendItem: View {
		let tint: Color
		let text: String

		var body: some View {
			HStack(spacing: 6) {
				Rectangle().fill(tint).frame(width: 10, height: 2)
				Text(text)
					.font(Typo.micro)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
		}
	}
}

/// How the operations table is ranked; the header's label cycles through.
private enum OperationSort: String, CaseIterable {
	case failures
	case latency
	case volume

	var title: String {
		switch self {
		case .failures: "By failures"
		case .latency: "By latency"
		case .volume: "By volume"
		}
	}

	var next: OperationSort {
		let all = Self.allCases
		let index = all.firstIndex(of: self) ?? 0
		return all[(index + 1) % all.count]
	}
}

/// The busiest operations as a table: name, p95 and error rate. Overview
/// shows the top few; the Operations segment shows them all.
private struct OperationsSection: View {
	let operations: [ServiceOperation]
	let window: TimeWindow
	@Binding var sort: OperationSort
	/// Nil shows every operation.
	let limit: Int?

	private var ranked: [ServiceOperation] {
		switch sort {
		case .failures:
			operations.sorted { a, b in
				a.errorCount != b.errorCount ? a.errorCount > b.errorCount : a.errorRate > b.errorRate
			}
		case .latency:
			operations.sorted { $0.p95LatencyMs > $1.p95LatencyMs }
		case .volume:
			operations.sorted { $0.estimatedSpanCount > $1.estimatedSpanCount }
		}
	}

	var body: some View {
		let rows = ranked
		let visible = limit.map { Array(rows.prefix($0)) } ?? rows
		VStack(alignment: .leading, spacing: 8) {
			ServiceSectionHeader(title: "Operations", count: operations.count) {
				if operations.count > 1 {
					Button {
						sort = sort.next
						Telemetry.track(Telemetry.Event.serviceOperationsSorted, ["sort": sort.rawValue])
					} label: {
						Text(sort.title)
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.frame(minHeight: 28)
							.contentShape(.rect)
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Sort operations, \(sort.title)")
				}
			}

			if operations.isEmpty {
				Text("No operations recorded in \(window.phrase).")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
			} else {
				TableCard(columns: ["Operation", "P95", "Errors"]) {
					ForEach(visible, id: \.name) { operation in
						TableRow {
							Text(operation.name.isEmpty ? "(unnamed)" : operation.name)
								.font(Typo.body)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
								.truncationMode(.middle)
						} trailing: {
							TableCell(text: Format.latency(operation.p95LatencyMs), tint: Token.chartP95)
							TableCell(
								text: Format.errorRate(operation.errorRate),
								tint: operation.errorRate >= 0.01 ? Tone.errorRate(operation.errorRate) : Token.foreground
							)
						}
						.accessibilityElement(children: .combine)
					}
				}
			}
		}
	}
}
