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
			}
		}
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .principal) {
				HStack(spacing: 6) {
					ServiceDot(serviceName: serviceName, size: 8)
					Text(serviceName)
						.font(Typo.monoTitle)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
				}
			}
			if let model {
				ToolbarItem(placement: .topBarTrailing) {
					TimeWindowMenu(
						window: Binding(
							get: { model.window },
							set: { newValue in
								model.window = newValue
								Telemetry.track(
									Telemetry.Event.timeWindowChanged,
									["screen": Screen.serviceDetail, "window": newValue.rawValue]
								)
								Task { await model.loader.load(.replace) }
							}
						)
					)
				}
			}
		}
		.mapleScreen(Screen.serviceDetail)
		.task(id: scope) {
			let model =
				model?.scope == scope
				? model!
				: ServiceDetailModel(
					serviceName: serviceName,
					window: window,
					api: session.api.scoped(toEnvironment: scope.environment),
					session: session,
					scope: scope
				)
			self.model = model
			await model.start()
		}
	}
}

private struct ServiceDetailContent: View {
	let detail: ServiceDetail
	let window: TimeWindow

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
		VStack(alignment: .leading, spacing: 28) {
			VerdictHeadline(verdict: ServiceHealth.verdict(for: service, window: window))
				.padding(.horizontal, 16)

			SignalCard(
				points: SignalPoint.from(detail.overview),
				window: resolvedWindow,
				baselineP95: LatencyBaseline(service: service)?.p95LatencyMs
			)
			.padding(.horizontal, 16)

			Block(title: "Over \(window.phrase)") {
				StatGrid(columns: 3) {
					StatTile(
						label: "Requests",
						value: Format.count(service.throughput * resolvedWindow.end.timeIntervalSince(resolvedWindow.start))
					)
					StatTile(
						label: "Error rate",
						value: Format.errorRate(service.errorRate),
						tint: Tone.errorRate(service.errorRate)
					)
					StatTile(
						label: "p95",
						value: Format.latency(service.p95LatencyMs),
						tint: Tone.latency(service.p95LatencyMs, scale: .p95)
					)
				}
				.padding(.horizontal, 16)
			}

			if !detail.incidents.isEmpty {
				Block(title: "Open alerts", count: detail.incidents.count) {
					VStack(spacing: 8) {
						ForEach(detail.incidents) { card in
							NavigationLink(value: Route.incident(id: card.id)) {
								IncidentCardView(card: card)
							}
							.buttonStyle(.plain)
						}
					}
					.padding(.horizontal, 16)
				}
			}

			OperationsSection(operations: detail.overview.operations, window: window)

			Block(title: "Open issues", count: detail.issues.isEmpty ? nil : detail.issues.count) {
				if detail.issues.isEmpty {
					Text("Nothing needs attention in \(window.phrase).")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.padding(.horizontal, 16)
				} else {
					VStack(spacing: 0) {
						ForEach(detail.issues, id: \.id) { issue in
							NavigationLink(value: Route.issue(id: issue.id)) {
								IssueRow(issue: issue, showsService: false)
							}
							.buttonStyle(RowButtonStyle())
							Hairline()
						}
					}
				}
			}

			Block(title: "Volume") {
				VStack(spacing: 0) {
					DetailRow("Spans", Format.count(service.spanCount))
					Hairline()
					DetailRow("Errors", Format.count(service.errorCount))
					Hairline()
					if service.hasSampling {
						// Sampled data means the raw counts understate reality;
						// saying so is more useful than silently scaling.
						DetailRow("Sampling", "1 in \(Format.count(service.samplingWeight))")
						Hairline()
						DetailRow("Est. throughput", Format.throughput(service.tracedThroughput))
						Hairline()
					}
					if !service.deploymentEnvironments.isEmpty {
						DetailRow("Environments", service.deploymentEnvironments.joined(separator: ", "))
						Hairline()
					}
					if !service.serviceNamespaces.isEmpty {
						DetailRow("Namespaces", service.serviceNamespaces.joined(separator: ", "))
						Hairline()
					}
				}
				.padding(.horizontal, 16)
			}

			Text("Updated \(detail.loadedAt.formatted(date: .omitted, time: .shortened))")
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground.opacity(0.6))
				.padding(.horizontal, 16)
		}
		.padding(.top, 8)
		.padding(.bottom, 24)
	}
}

private struct Block<Content: View>: View {
	let title: String
	var count: Int? = nil
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				SectionLabel(title)
				if let count {
					Text("\(count)")
						.font(Typo.microMedium)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
				}
			}
			.padding(.horizontal, 16)
			content
		}
	}
}

/// The verdict and the sentence behind it — the only place on the screen the
/// health colour is allowed to be loud, as on Home.
private struct VerdictHeadline: View {
	let verdict: ServiceHealth.Verdict

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(alignment: .firstTextBaseline, spacing: 10) {
				Circle()
					.fill(verdict.health.tint)
					.frame(width: 8, height: 8)
					.offset(y: -1)
				Text(verdict.title)
					.font(Typo.title)
					.foregroundStyle(Token.foreground)
			}
			Text(verdict.reason)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)
				.padding(.leading, 18)
		}
		.padding(.top, 8)
		.accessibilityElement(children: .combine)
	}
}

/// One signal at a time, full width. The number is the latest settled bucket
/// — what the service is doing *now* — with the window's peak and average as
/// the small print, because an average over a day answers a different
/// question than the one someone opens this screen with. Scrubbing the chart
/// swaps the number for the bucket under the finger.
private struct SignalCard: View {
	let points: [SignalPoint]
	let window: ResolvedTimeWindow
	let baselineP95: Double?

	@State private var kind: SignalKind = .throughput
	@State private var scrubbed: SignalPoint?

	private var shown: SignalPoint? { scrubbed ?? points.settled }

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			SegmentChips(
				options: SignalKind.allCases.map { ($0, $0.title) },
				selection: Binding(
					get: { kind },
					set: { next in
						kind = next
						scrubbed = nil
						Telemetry.track(Telemetry.Event.serviceSignalChanged, ["signal": next.rawValue])
					}
				)
			)

			if points.count < 2 {
				Text("Not enough traffic in this window to chart.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.frame(height: 160)
					.frame(maxWidth: .infinity)
			} else {
				headline
				SignalChart(
					points: points,
					kind: kind,
					window: window,
					baselineP95: baselineP95,
					scrubbed: $scrubbed
				)
				.frame(height: 170)
				footer
			}
		}
		.padding(12)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
	}

	/// "now" or the scrubbed bucket's time, then the value in the signal's unit.
	@ViewBuilder
	private var headline: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(scrubbed == nil ? "Now" : (shown?.date.formatted(date: .omitted, time: .shortened) ?? ""))
					.font(Typo.micro)
					.textCase(.uppercase)
					.tracking(1.2)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
				if scrubbed == nil, let trend = trendLabel {
					Text(trend)
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground.opacity(0.8))
				}
			}
			switch kind {
			case .throughput:
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(Format.throughput(shown?.throughput ?? 0))
						.font(Typo.statValue)
						.tabularNumbers()
						.foregroundStyle(Token.foreground)
					Text("\(Format.count(shown?.requests ?? 0)) requests in the bucket")
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
				}
			case .errors:
				Text(Format.errorRate(shown?.errorRate ?? 0))
					.font(Typo.statValue)
					.tabularNumbers()
					.foregroundStyle(Tone.errorRate(shown?.errorRate ?? 0))
			case .latency:
				HStack(alignment: .top, spacing: 14) {
					Percentile(label: "p50", value: shown?.p50, tint: Token.chartP50, scale: .p50)
					Percentile(label: "p95", value: shown?.p95, tint: Token.chartP95, scale: .p95, emphasis: true)
					Percentile(label: "p99", value: shown?.p99, tint: Token.chartP99, scale: .p99)
				}
			}
		}
		.animation(nil, value: scrubbed)
	}

	/// The window's shape in two numbers, so the "now" above it has context.
	private var footer: some View {
		HStack(spacing: 12) {
			switch kind {
			case .throughput:
				Fact(label: "peak", value: Format.throughput(points.map(\.throughput).max() ?? 0))
				Fact(label: "avg", value: Format.throughput(average(points.map(\.throughput))))
			case .errors:
				Fact(label: "peak", value: Format.errorRate(points.map(\.errorRate).max() ?? 0))
				Fact(label: "buckets over 1%", value: "\(points.filter { $0.errorRate >= 0.01 }.count)")
			case .latency:
				Fact(label: "p95 peak", value: Format.latency(points.map(\.p95).max() ?? 0))
				if let baselineP95 {
					Fact(label: "7d p95", value: Format.latency(baselineP95))
				}
			}
			Spacer(minLength: 0)
			Text("\(points.count) buckets")
				.font(Typo.micro)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground.opacity(0.6))
		}
	}

	/// How the settled bucket compares with the first half of the window —
	/// "+38% vs earlier" — so a climb reads as a climb even before the chart
	/// is looked at. Nil when there is too little to compare.
	private var trendLabel: String? {
		guard points.count >= 6, let now = points.settled else { return nil }
		let earlier = Array(points.prefix(points.count / 2))
		let current: Double
		let reference: Double
		switch kind {
		case .throughput:
			current = now.throughput
			reference = average(earlier.map(\.throughput))
		case .errors:
			current = now.errorRate
			reference = average(earlier.map(\.errorRate))
		case .latency:
			current = now.p95
			reference = average(earlier.map(\.p95))
		}
		guard reference > 0, current.isFinite else { return nil }
		let change = (current - reference) / reference
		guard abs(change) >= 0.05 else { return "steady vs earlier" }
		let percent = Int((abs(change) * 100).rounded())
		return "\(change > 0 ? "+" : "−")\(percent)% vs earlier"
	}

	private func average(_ values: [Double]) -> Double {
		let finite = values.filter(\.isFinite)
		return finite.isEmpty ? 0 : finite.reduce(0, +) / Double(finite.count)
	}

	private struct Percentile: View {
		let label: String
		let value: Double?
		let tint: Color
		let scale: Tone.LatencyScale
		var emphasis = false

		var body: some View {
			VStack(alignment: .leading, spacing: 2) {
				HStack(spacing: 4) {
					Circle().fill(tint).frame(width: 5, height: 5)
					Text(label)
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
				}
				Text(value.map(Format.latency) ?? "—")
					.font(emphasis ? Typo.statValue : Typo.bodyMedium)
					.tabularNumbers()
					.foregroundStyle(value.map { Tone.latency($0, scale: scale) } ?? Token.mutedForeground)
			}
		}
	}

	private struct Fact: View {
		let label: String
		let value: String

		var body: some View {
			HStack(spacing: 4) {
				Text(label)
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground.opacity(0.7))
				Text(value)
					.font(Typo.tinyMedium)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
		}
	}
}

/// The busiest operations, re-ranked in place: by errors when triaging, by
/// p95 when chasing latency, by volume to see what the service is. Every row
/// carries all three numbers so switching the sort only moves rows.
private struct OperationsSection: View {
	let operations: [ServiceOperation]
	let window: TimeWindow

	private enum Sort: String, CaseIterable {
		case errors
		case latency
		case volume

		var title: String {
			switch self {
			case .errors: "Failing"
			case .latency: "Slowest"
			case .volume: "Busiest"
			}
		}
	}

	private static let collapsedCount = 6

	@State private var sort: Sort = .errors
	@State private var expanded = false

	private var ranked: [ServiceOperation] {
		switch sort {
		case .errors:
			return operations.filter { $0.errorCount > 0 }.sorted { a, b in
				a.errorCount != b.errorCount ? a.errorCount > b.errorCount : a.errorRate > b.errorRate
			}
		case .latency:
			return operations.sorted { $0.p95LatencyMs > $1.p95LatencyMs }
		case .volume:
			return operations.sorted { $0.estimatedSpanCount > $1.estimatedSpanCount }
		}
	}

	private func metric(_ operation: ServiceOperation) -> Double {
		switch sort {
		case .errors: operation.errorCount
		case .latency: operation.p95LatencyMs
		case .volume: operation.estimatedSpanCount
		}
	}

	var body: some View {
		let rows = ranked
		let visible = expanded ? rows : Array(rows.prefix(Self.collapsedCount))
		let peak = visible.map(metric).max() ?? 0
		VStack(alignment: .leading, spacing: 10) {
			HStack {
				SectionLabel("Operations")
				Spacer(minLength: 8)
				SegmentChips(
					options: Sort.allCases.map { ($0, $0.title) },
					selection: Binding(
						get: { sort },
						set: { next in
							sort = next
							Telemetry.track(Telemetry.Event.serviceOperationsSorted, ["sort": next.rawValue])
						}
					)
				)
			}
			.padding(.horizontal, 16)

			if operations.isEmpty {
				Text("No operations recorded in \(window.phrase).")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.padding(.horizontal, 16)
			} else if rows.isEmpty {
				Text("No operation failed in \(window.phrase).")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.padding(.horizontal, 16)
			} else {
				VStack(spacing: 0) {
					ForEach(visible, id: \.name) { operation in
						OperationRow(operation: operation, share: peak > 0 ? metric(operation) / peak : 0, sort: sort)
						Hairline()
					}
				}
				if rows.count > Self.collapsedCount {
					Button {
						withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
					} label: {
						Text(expanded ? "Show fewer" : "Show all \(rows.count)")
							.font(Typo.smallMedium)
							.foregroundStyle(Token.foreground)
							.padding(.horizontal, 10)
							.frame(height: 28)
							.background(Token.muted, in: .rect(cornerRadius: Token.Radius.md))
					}
					.buttonStyle(.plain)
					.padding(.horizontal, 16)
				}
			}
		}
	}

	/// Name, then the three numbers with the sort's own emphasised, then a bar
	/// scaled to the largest row on screen.
	private struct OperationRow: View {
		let operation: ServiceOperation
		let share: Double
		let sort: Sort

		private var barTint: Color {
			switch sort {
			case .errors: Token.chartError
			case .latency: Token.chartP95
			case .volume: Token.mutedForeground
			}
		}

		var body: some View {
			VStack(alignment: .leading, spacing: 6) {
				Text(operation.name.isEmpty ? "(unnamed)" : operation.name)
					.font(Typo.small)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
					.truncationMode(.middle)
				HStack(spacing: 12) {
					Stat(
						value: Format.count(operation.estimatedSpanCount),
						unit: "req",
						tint: sort == .volume ? Token.foreground : Token.mutedForeground
					)
					Stat(
						value: Format.errorRate(operation.errorRate),
						unit: "err",
						tint: sort == .errors ? Tone.errorRate(operation.errorRate) : Token.mutedForeground
					)
					Stat(
						value: Format.latency(operation.p95LatencyMs),
						unit: "p95",
						tint: sort == .latency ? Tone.latency(operation.p95LatencyMs, scale: .p95) : Token.mutedForeground
					)
					Spacer(minLength: 0)
				}
				GeometryReader { proxy in
					Rectangle()
						.fill(barTint.opacity(0.7))
						.frame(width: max(2, proxy.size.width * CGFloat(share)))
				}
				.frame(height: 3)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 9)
		}

		private struct Stat: View {
			let value: String
			let unit: String
			let tint: Color

			var body: some View {
				HStack(spacing: 3) {
					Text(value)
						.font(Typo.tinyMedium)
						.tabularNumbers()
						.foregroundStyle(tint)
					Text(unit)
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground.opacity(0.6))
				}
			}
		}
	}
}
