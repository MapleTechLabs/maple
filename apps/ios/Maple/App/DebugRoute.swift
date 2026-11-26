#if DEBUG
	import Foundation
	import MapleAPI

	/// `maple://debug/<path>` opens any screen for the latency harness and screenshots
	/// (Debug only): `home`, `services`, `triage/<segment>`, `explore/<segment>`,
	/// `search`, `oncall`, `org|service|issue|incident|anomaly|trace|dashboard|schedule/<id>`.
	/// `reachability/<denied|timesensitive|unregistered|ok>` forces what the page
	/// reachability surfaces show until the app quits; any other state lifts it.
	enum DebugRoute {
		@MainActor
		static func open(_ url: URL, navigation: AppNavigation, session: SessionController) -> Bool {
			guard url.scheme == "maple", url.host == "debug" else { return false }
			let parts = url.pathComponents.filter { $0 != "/" }
			guard let head = parts.first else { return true }
			let arg = parts.dropFirst().joined(separator: "/")
			switch head {
			case "org": Task { await session.select(organizationId: arg) }
			case "home":
				navigation.homePath = []
				navigation.tab = .home
			case "oncall":
				navigation.homePath = [.onCall()]
				navigation.tab = .home
			case "schedule":
				// Under the On call screen, so back goes where a tap would have come from.
				navigation.homePath = [.onCall(), .schedule(id: arg)]
				navigation.tab = .home
			case "reachability":
				// Only what the app draws: the phone's own settings are left alone,
				// and the screen stays where it is so the state can be flipped in place.
				PushRegistrar.shared.debugReachability = reachability(arg)
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

		/// What the phone would know in each forced state. Nil for a state not listed.
		private static func reachability(_ state: String) -> PageReachability? {
			switch state {
			case "denied": PageReachability(authorization: .denied)
			case "timesensitive": PageReachability(authorization: .authorized, timeSensitiveEnabled: false)
			case "unregistered": PageReachability(authorization: .authorized, registration: .missing)
			case "ok": PageReachability(authorization: .authorized)
			default: nil
			}
		}
	}
#endif
