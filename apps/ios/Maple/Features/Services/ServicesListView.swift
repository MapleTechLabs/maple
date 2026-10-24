import MapleAPI
import SwiftUI

@MainActor
@Observable
final class ServicesListModel {
	private(set) var loader: ScreenLoader<[Service]>!
	var window: TimeWindow = .default
	/// The organization *and* environment these rows answer for. The view
	/// rebuilds the model when it moves.
	let scope: SessionController.DataScope

	private let api: any MapleAPI
	/// The cache key's stable half — `scope.generation` moves every sign-in.
	private let organizationId: String?

	init(api: any MapleAPI, session: SessionController, scope: SessionController.DataScope) {
		self.api = api
		self.scope = scope
		self.organizationId = session.currentOrganizationId
		self.loader = ScreenLoader(session: session, screen: Screen.services, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<[Service]> { loader.state }

	/// First appearance for this scope: paint the persisted list if there is
	/// one and revalidate, otherwise load cold. Only the default window seeds —
	/// a cached list answers "now", not a picked historical window.
	func start() async {
		if !loader.state.hasContent, !loader.isLoading, window == .default, let organizationId,
			let cached = SnapshotCache.load(
				[Service].self,
				screen: Screen.services,
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

	private func fetch() async throws -> [Service] {
		let resolved = window.resolve()
		let services = try await api.services(window: resolved, limit: 50).items
		let rows = sorted(services)
		// Persist only the window the next launch will seed with.
		if window == .default, let organizationId {
			SnapshotCache.save(
				rows,
				screen: Screen.services,
				organizationId: organizationId,
				environment: scope.environment
			)
		}
		return rows
	}

	/// Unhealthy first, then by error rate, then by volume — so the rows that
	/// need attention are the ones on screen without scrolling.
	private func sorted(_ services: [Service]) -> [Service] {
		services.sorted { first, second in
			let a = ServiceHealth(service: first)
			let b = ServiceHealth(service: second)
			if a != b { return a.rank > b.rank }
			if first.errorRate != second.errorRate { return first.errorRate > second.errorRate }
			return first.throughput > second.throughput
		}
	}
}

struct ServicesListView: View {
	@Environment(SessionController.self) private var session
	@Environment(AppNavigation.self) private var navigation
	@Environment(EnvironmentController.self) private var environments
	@State private var model: ServicesListModel?
	@State private var search = ""

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

	private var window: TimeWindow { model?.window ?? .default }

	var body: some View {
		@Bindable var navigation = navigation
		// The path lives in `AppNavigation` so the throughput widget can open a
		// service from outside the view tree, same reason as the Alerts hub.
		return NavigationStack(path: $navigation.servicesPath) {
			ZStack {
				Token.background.ignoresSafeArea()
				content
			}
			// Hidden here; it names the back button on pushed screens.
			.navigationTitle("Services")
			.tabRootChrome()
			.mapleDestinations()
			.mapleScreen(Screen.services)
		}
		// Re-runs on an org switch or an environment change, which is what clears
		// one scope's services before the next scope's arrive. The environment is
		// in the key because it can resolve after the first build.
		.task(id: scope) {
			let model =
				if let model, model.scope == scope { model } else {
					ServicesListModel(
						api: session.api.scoped(toEnvironment: scope.environment),
						session: session,
						scope: scope
					)
				}
			self.model = model
			await model.start()
		}
	}

	private var status: TabRootStatus {
		let count = model?.state.value?.count
		let lead = count.map { "\($0) \($0 == 1 ? "service" : "services") · " } ?? ""
		return TabRootStatus(dot: nil, lead: "", detail: "\(lead)last \(window.compactTitle)")
	}

	private var content: some View {
		LoadableView(
			loader: model?.loader,
			emptyTitle: "No services",
			emptyMessage: "No services reported telemetry in \(window.phrase).",
			skeletonRowHeight: 64
		) {
			VStack(alignment: .leading, spacing: 0) {
				TabRootHeader(title: "Services", status: status)
				// In the header so the window stays changeable from the empty
				// and error states too.
				VStack(alignment: .leading, spacing: 12) {
					if let model {
						WindowChips(window: windowBinding(model))
					}
					FilterField(prompt: "Filter services", text: $search)
				}
				.padding(.horizontal, 16)
				.padding(.top, 16)
			}
		} content: { services in
			servicesTable(filtered(services))
				.padding(.horizontal, 16)
				.padding(.top, 16)
				.padding(.bottom, 24)
		}
	}

	@ViewBuilder
	private func servicesTable(_ visible: [Service]) -> some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionHeader(title: "Worst first", note: "p50 · p95 · p99")
			if visible.isEmpty {
				EmptyStateView(title: "No matches", message: "No service name contains \u{201C}\(search)\u{201D}.")
					.padding(.top, 32)
			} else {
				VStack(spacing: 0) {
					ForEach(Array(visible.enumerated()), id: \.element.name) { index, service in
						NavigationLink(value: Route.service(name: service.name, window: window)) {
							ServiceRow(service: service)
						}
						.buttonStyle(RowButtonStyle())
						if index < visible.count - 1 { Hairline() }
					}
				}
				.hairlineCard()
			}
		}
	}

	private func filtered(_ services: [Service]) -> [Service] {
		let query = search.trimmingCharacters(in: .whitespaces)
		guard !query.isEmpty else { return services }
		return services.filter { $0.name.localizedCaseInsensitiveContains(query) }
	}

	private func windowBinding(_ model: ServicesListModel) -> Binding<TimeWindow> {
		Binding(
			get: { model.window },
			set: { newValue in
				model.window = newValue
				Telemetry.track(
					Telemetry.Event.timeWindowChanged,
					["screen": Screen.services, "window": newValue.rawValue]
				)
				Task { await model.loader.load(.replace) }
			}
		)
	}
}

/// One service: swatch, name and health dot over its percentiles, with
/// throughput and error rate on the right.
private struct ServiceRow: View {
	let service: Service

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 8) {
				ServiceDot(serviceName: service.name)
				Text(service.name)
					.font(Typo.body)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
					.truncationMode(.middle)
				HealthDot(health: ServiceHealth(service: service))
				Spacer(minLength: 8)
				Text(Format.rps(service.throughput))
					.font(Typo.body)
					.tabularNumbers()
					.foregroundStyle(Token.foreground)
					.layoutPriority(1)
			}
			HStack(spacing: 12) {
				PercentileTriplet(
					p50: service.p50LatencyMs,
					p95: service.p95LatencyMs,
					p99: service.p99LatencyMs,
					showsLabels: false
				)
				Spacer(minLength: 8)
				Text("\(Format.errorRate(service.errorRate)) err")
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Tone.errorRate(service.errorRate))
					.layoutPriority(1)
			}
			.padding(.leading, 16)
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 10)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}

/// List rows lift one tonal step on press — the same `hover:bg-muted/50` idea,
/// translated to touch.
struct RowButtonStyle: ButtonStyle {
	func makeBody(configuration: ButtonStyleConfiguration) -> some View {
		configuration.label
			.background(configuration.isPressed ? Token.muted.opacity(0.5) : .clear)
	}
}

