#if DEBUG
	import Foundation

	/// `maple://debug/<path>`: puts any screen on top for the latency harness
	/// (`scripts/measure-latency.sh`) and screenshots. Debug builds only.
	///
	/// Paths: `org/<id>`, `home`, `services`, `triage/<errors|incidents|anomalies>`,
	/// `explore/<traces|logs|dashboards>`, `search`, `service/<name>`,
	/// `issue/<id>`, `incident/<id>`, `anomaly/<id>`, `trace/<id>`, `dashboard/<id>`.
	enum DebugRoute {
		@MainActor
		static func open(_ url: URL, navigation: AppNavigation, session: SessionController) -> Bool {
			guard url.scheme == "maple", url.host == "debug" else { return false }
			let parts = url.pathComponents.filter { $0 != "/" }
			guard let head = parts.first else { return true }
			let arg = parts.dropFirst().joined(separator: "/")
			switch head {
			case "org": Task { await session.select(organizationId: arg) }
			case "home": navigation.tab = .home
			case "services":
				navigation.servicesPath = []
				navigation.tab = .services
			case "triage":
				navigation.alertsPath = []
				navigation.open(AlertsSegment(rawValue: arg) ?? .errors)
			case "explore":
				navigation.explorePath = []
				navigation.exploreSegment = ExploreSegment(rawValue: arg) ?? .traces
				navigation.tab = .explore
			case "search": navigation.tab = .search
			case "service": navigation.openService(name: arg)
			case "issue": navigation.openIssue(id: arg)
			case "incident": navigation.openIncident(id: arg)
			case "anomaly":
				navigation.alertsSegment = .anomalies
				navigation.alertsPath = [.anomaly(id: arg)]
				navigation.tab = .alerts
			case "trace":
				navigation.explorePath = [.trace(id: arg)]
				navigation.tab = .explore
			case "dashboard":
				navigation.exploreSegment = .dashboards
				navigation.explorePath = [.dashboard(id: arg, name: "")]
				navigation.tab = .explore
			default: break
			}
			return true
		}
	}
#endif
