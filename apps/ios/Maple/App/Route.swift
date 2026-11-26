import MapleAPI
import MapleWidgetData
import SwiftUI

/// Every push destination in the app.
///
/// One enum, registered once per `NavigationStack` via `mapleDestinations()`,
/// so a service row on Home, an incident's service link, and the Services tab
/// all resolve the same way — and adding a screen is one case, not a hunt
/// through every stack for a missing `navigationDestination`.
enum Route: Hashable {
	case service(name: String, window: TimeWindow = .default)
	case issue(id: String)
	case incident(id: String)
	case anomaly(id: String)
	/// A trace's waterfall, optionally opened on one span.
	case trace(id: String, spanId: String? = nil)
	case dashboard(id: String, name: String)
	/// Who is on call and when the viewer is. `seed` is an overview the caller
	/// already holds, so the screen paints without waiting on its own read.
	case onCall(seed: OnCallOverview? = nil)
	/// One schedule, read-only, drawn from the same overview document.
	case schedule(id: String, seed: OnCallOverview? = nil)
	/// The Alerts tab, opened on a specific segment. Handled by the tab
	/// switcher rather than by push — see `AppNavigation`.
	case alerts(AlertsSegment)
}

/// Triage's segments, in the web sidebar's order: errors lead, then alerts.
enum AlertsSegment: String, CaseIterable, Identifiable, Hashable {
	case errors
	case incidents
	case anomalies

	var id: String { rawValue }

	var title: String {
		switch self {
		case .incidents: "Alerts"
		case .errors: "Errors"
		case .anomalies: "Anomalies"
		}
	}
}

extension View {
	func mapleDestinations() -> some View {
		navigationDestination(for: Route.self) { route in
			switch route {
			case .service(let name, let window):
				ServiceDetailView(serviceName: name, window: window)
			case .issue(let id):
				IssueDetailView(issueID: id)
			case .incident(let id):
				IncidentDetailView(incidentID: id)
			case .anomaly(let id):
				AnomalyDetailView(anomalyID: id)
			case .trace(let id, let spanId):
				TraceDetailView(traceID: id, initialSpanID: spanId)
			case .dashboard(let id, let name):
				DashboardDetailView(dashboardID: id, name: name)
			case .onCall(let seed):
				OnCallView(seed: seed)
			case .schedule(let id, let seed):
				ScheduleView(scheduleID: id, seed: seed)
			case .alerts:
				// Cross-tab: Home asks the tab bar to switch. Rendering it inline
				// would nest a hub inside a stack.
				EmptyView()
			}
		}
	}
}

/// Cross-tab navigation state. Home's "3 new issues" row switches to the Alerts
/// tab on the Errors segment; that's a tab change plus a segment change, which
/// no `NavigationStack` can express, so it lives here.
@MainActor
@Observable
final class AppNavigation {
	var tab: AppTab = .home
	var alertsSegment: AlertsSegment = .errors
	/// The Overview tab's stack, owned here so the on-call screens can be opened
	/// from outside the view tree.
	var homePath: [Route] = []
	/// The Alerts tab's stack. Owned here so a notification tap can push an
	/// incident onto it from outside the view tree.
	var alertsPath: [Route] = []
	/// The Services tab's stack, owned here for the same reason: the
	/// throughput widget opens the service it was configured for.
	var servicesPath: [Route] = []
	/// The Explore tab's stack and segment.
	var explorePath: [Route] = []
	var exploreSegment: ExploreSegment = .traces
	/// The organization the Overview stack was built under.
	@ObservationIgnored private var organizationId: String?

	/// The session ended. Every stack held the previous account's screens, and
	/// the next account must not be handed them.
	func reset() {
		tab = .home
		alertsSegment = .errors
		exploreSegment = .traces
		homePath = []
		alertsPath = []
		servicesPath = []
		explorePath = []
		organizationId = nil
	}

	/// The organization on screen. Overview's stack goes with the one it was built
	/// under: its on-call screens carry that organization's overview. The other
	/// stacks stay, because a tapped notification switches and then pushes onto them.
	func show(organizationId: String) {
		guard organizationId != self.organizationId else { return }
		if self.organizationId != nil { homePath = [] }
		self.organizationId = organizationId
	}

	func open(_ segment: AlertsSegment) {
		alertsSegment = segment
		tab = .alerts
	}

	/// A tapped push: land on the incident, with the Alerts list underneath
	/// so back goes somewhere sensible.
	func openIncident(id: String) {
		alertsSegment = .incidents
		alertsPath = [.incident(id: id)]
		tab = .alerts
	}

	/// A tapped throughput widget: the service, with the Services list
	/// underneath so back goes somewhere sensible.
	func openService(name: String) {
		servicesPath = [.service(name: name)]
		tab = .services
	}

	/// A tapped widget row: the issue, with the Errors list underneath.
	func openIssue(id: String) {
		alertsSegment = .errors
		alertsPath = [.issue(id: id)]
		tab = .alerts
	}

	/// Put a destination on screen. Which organization it belongs to has already
	/// been settled by `DestinationOpener`; this is only routing.
	func go(_ target: WidgetDeepLink.Target) {
		switch target {
		case .incident(let id): openIncident(id: id)
		case .issue(let id): openIssue(id: id)
		case .service(let name): openService(name: name)
		case .incidentsList: open(.incidents)
		case .issuesList: open(.errors)
		case .servicesList:
			servicesPath = []
			tab = .services
		}
	}
}

enum AppTab: Hashable {
	case home
	case services
	case alerts
	case explore
	/// The search tab: services, issues and trace ids.
	case search
}

/// Explore's segments: the web sidebar's Analyze group.
enum ExploreSegment: String, CaseIterable, Identifiable, Hashable {
	case traces
	case logs
	case dashboards

	var id: String { rawValue }

	var title: String {
		switch self {
		case .traces: "Traces"
		case .logs: "Logs"
		case .dashboards: "Dashboards"
		}
	}
}
