import MapleAPI
import SwiftUI

/// The pulse. Everything above the fold answers "is anything wrong right now";
/// everything below it is the shortest path to "why".
struct HomeView: View {
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@Environment(\.scenePhase) private var scenePhase
	@State private var model: HomeModel?
	@State private var showsNotificationSettings = false

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()
				LoadableView(
					loader: model?.loader,
					emptyTitle: "Nothing yet",
					emptyMessage: "No services have reported telemetry.",
					header: {
						TabRootHeader(title: "Overview", status: status)
							.overlay(alignment: .topTrailing) { notificationsButton }
					},
					skeleton: { HomeSkeleton() }
				) { snapshot in
					HomeContent(snapshot: snapshot)
				}
			}
			// Hidden on the root; it names the back button on pushed screens.
			.navigationTitle("Overview")
			.tabRootChrome()
			.sheet(isPresented: $showsNotificationSettings) {
				NotificationSettingsView().environment(session)
			}
			.mapleDestinations()
			.mapleScreen(Screen.home)
		}
		.task(id: scope) {
			// A new org or environment means a new model: the old board is
			// dropped rather than left on screen until the new one arrives, and
			// any refresh still running against the old scope has nowhere to
			// write.
			let model =
				if let model, model.scope == scope { model }
				else {
					HomeModel(
						api: session.api.scoped(toEnvironment: scope.environment),
						session: session,
						scope: scope
					)
				}
			self.model = model
			await model.start()
			// Home is a status board: keep it current while it's on screen.
			// `.task` is cancelled when the tab goes away, so this never runs
			// off-tab; the scene-phase check keeps it from running off-screen.
			while !Task.isCancelled {
				try? await Task.sleep(for: .seconds(60))
				guard !Task.isCancelled, scenePhase == .active else { continue }
				await model.loader.load(.refresh)
			}
		}
		.onChange(of: scenePhase) { _, phase in
			// Coming back from the background: the board is as old as the
			// absence, so refresh unless it is genuinely fresh.
			guard phase == .active, let model, let loadedAt = model.state.value?.loadedAt,
				Date().timeIntervalSince(loadedAt) > 30
			else { return }
			Task { await model.loader.load(.refresh) }
		}
	}
}

extension HomeView {
	/// The header's status line, once there is a board to describe.
	private var status: TabRootStatus? {
		guard let snapshot = model?.state.value else { return nil }
		let line = snapshot.statusLine
		let dot: Color? =
			switch snapshot.status {
			case .noData: nil
			case .healthy: Token.success
			case .degraded: Token.severityWarn
			case .critical: Token.destructive
			}
		return TabRootStatus(dot: dot, lead: line.lead, detail: line.detail)
	}

	/// Trailing on the title row: the header's pill row is 52pt and the title
	/// sits 8pt under it, so the bell centres on the 34pt title line.
	private var notificationsButton: some View {
		Button {
			showsNotificationSettings = true
		} label: {
			PixelIcon.bell.image
				.resizable()
				.frame(width: 18, height: 18)
				.foregroundStyle(Token.foreground)
				.frame(width: 44, height: 44)
				.contentShape(.rect)
		}
		.accessibilityLabel("Notification settings")
		.padding(.top, 52 + 8 - 5)
		.padding(.trailing, 6)
	}
}

private struct HomeContent: View {
	let snapshot: HomeSnapshot
	@Environment(AppNavigation.self) private var navigation

	var body: some View {
		VStack(alignment: .leading, spacing: 28) {
			OverviewStats(snapshot: snapshot)

			if !snapshot.incidents.isEmpty {
				HomeSection(title: "Open alerts", count: snapshot.incidents.count, link: "Triage") {
					navigation.open(.incidents)
				} content: {
					VStack(spacing: 8) {
						ForEach(snapshot.incidents) { card in
							NavigationLink(value: Route.incident(id: card.id)) {
								IncidentCardView(card: card)
							}
							.buttonStyle(.plain)
						}
					}
				}
			}

			HomeSection(
				title: "Needs attention",
				count: snapshot.attention.isEmpty ? nil : snapshot.attention.count,
				link: "All services"
			) {
				navigation.servicesPath = []
				navigation.tab = .services
			} content: {
				if snapshot.attention.isEmpty {
					Text(
						snapshot.services.isEmpty
							? "No services reported in the last hour."
							: "All \(snapshot.services.count) services within thresholds."
					)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
				} else {
					TableCard(columns: ["Service", "Errors", "P95"]) {
						ForEach(snapshot.attention.prefix(6), id: \.name) { service in
							NavigationLink(value: Route.service(name: service.name, window: .lastHour)) {
								AttentionRow(service: service)
							}
							.buttonStyle(RowButtonStyle())
						}
					}
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 20)
		.padding(.bottom, 24)
	}
}

/// An uppercase label with its count, and a link to the tab that holds the
/// full list.
private struct HomeSection<Content: View>: View {
	let title: String
	let count: Int?
	let link: String
	let action: () -> Void
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			HStack(alignment: .firstTextBaseline, spacing: 6) {
				SectionLabel(title)
				if let count {
					Text("\(count)")
						.font(Typo.micro)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
				}
				Spacer(minLength: 8)
				Button(link, action: action)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.buttonStyle(.plain)
			}
			.accessibilityElement(children: .contain)
			.accessibilityAddTraits(.isHeader)
			content
		}
	}
}

/// An open incident: severity rail, rule name and age, the services it covers
/// with a severity badge, then the breach beside what the rule saw against its
/// threshold.
struct IncidentCardView: View {
	let card: IncidentCard

	private var incident: AlertIncident { card.incident }

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(incident.ruleName)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Spacer(minLength: 4)
				Text(Format.duration(from: incident.firstTriggeredAt))
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}

			HStack(spacing: 6) {
				if let first = card.serviceNames.first {
					ServiceDot(serviceName: first)
				}
				Text(serviceLabel)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
				MapleBadge(text: incident.severity.label, tint: incident.severity.tint, outlined: true)
					.padding(.leading, 2)
			}

			HStack(alignment: .bottom, spacing: 12) {
				VStack(alignment: .leading, spacing: 4) {
					Text(card.display.label)
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
					Text(
						Format.breach(
							observed: incident.lastObservedValue,
							comparator: incident.comparator,
							threshold: incident.threshold,
							upper: incident.thresholdUpper,
							unit: card.display.unit
						)
					)
					.font(Typo.smallSemibold)
					.tabularNumbers()
					.foregroundStyle(incident.severity.tint)
				}
				Spacer(minLength: 0)
				Sparkline(
					values: card.observations,
					tint: incident.severity.tint,
					reference: incident.threshold,
					fills: false,
					anchorsToZero: false
				)
				.frame(width: 96, height: 28)
			}
		}
		.padding(.leading, 16)
		.padding(.trailing, 14)
		.padding(.vertical, 14)
		.background(Token.card)
		.overlay(alignment: .leading) {
			Rectangle()
				.fill(incident.severity.tint)
				.frame(width: 2)
		}
		.clipShape(.rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
		.contentShape(.rect)
	}

	/// The covered services, then the group the incident fired for.
	private var serviceLabel: String {
		let names = card.serviceNames
		var label =
			if names.isEmpty { "All services" }
			else if names.count <= 2 { names.joined(separator: ", ") }
			else { "\(names[0]), \(names[1]) +\(names.count - 2)" }
		if let group = incident.groupKey, group != "__total__" { label += " · \(group)" }
		return label
	}
}

private struct AttentionRow: View {
	let service: ServiceSummary

	var body: some View {
		TableRow {
			HStack(spacing: 8) {
				ServiceDot(serviceName: service.name)
				Text(service.name)
					.font(Typo.body)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				HealthDot(health: service.health)
			}
		} trailing: {
			TableCell(text: Format.errorRate(service.errorRate), tint: Tone.errorRate(service.errorRate))
			TableCell(
				text: Format.latency(service.p95LatencyMs),
				tint: Tone.latency(service.p95LatencyMs, scale: .p95)
			)
		}
	}
}

/// The web overview's lead row: four tiles, each with its change against the
/// previous equally long window, so "is it getting worse" reads before any list.
private struct OverviewStats: View {
	let snapshot: HomeSnapshot
	@Environment(AppNavigation.self) private var navigation

	var body: some View {
		StatGrid(columns: 2) {
			StatTile(
				label: "Requests",
				value: Format.count(snapshot.totalRequests),
				delta: StatDelta(
					current: snapshot.totalRequests,
					previous: snapshot.previousRequests,
					higherIsBetter: true
				)
			)
			StatTile(
				label: "Error rate",
				value: snapshot.services.isEmpty ? "–" : Format.errorRate(snapshot.errorRate),
				delta: snapshot.services.isEmpty
					? nil
					: StatDelta(
						current: snapshot.errorRate,
						previous: snapshot.previousErrorRate,
						higherIsBetter: false,
						style: .points
					)
			)
			StatTile(
				label: "Slowest p95",
				value: snapshot.slowestP95.map(Format.latency) ?? "–",
				delta: snapshot.slowestP95.flatMap { current in
					StatDelta(
						current: current,
						previous: snapshot.previousSlowestP95,
						higherIsBetter: false,
						style: .milliseconds
					)
				}
			)
			Button {
				navigation.open(.errors)
			} label: {
				StatTile(label: "Open issues", value: snapshot.openIssues.map(String.init) ?? "–", note: newIssuesNote)
			}
			.buttonStyle(.plain)
			.accessibilityHint("Opens error issues")
		}
	}

	/// `2 new today` in the warn tint; nothing while the count is loading.
	private var newIssuesNote: (text: String, tint: Color)? {
		guard let newIssues = snapshot.newIssues else { return nil }
		return newIssues > 0
			? ("\(newIssues) new today", Token.severityWarn)
			: ("None new today", Token.mutedForeground)
	}
}
