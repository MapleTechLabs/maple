import Foundation

/// Pages on the web dashboard, for the "Open on web" buttons. The host follows
/// the API the app talks to (`AppConfig.webBaseURL`), so EU and previews match.
enum MapleWeb {
	static func service(_ name: String) -> URL { AppConfig.webURL("/services/\(name)") }
	static func issue(_ id: String) -> URL { AppConfig.webURL("/errors/issues/\(id)") }
	static func incident(_ id: String) -> URL { AppConfig.webURL("/alerts/incidents/\(id)") }
	static func trace(_ id: String) -> URL { AppConfig.webURL("/traces/\(id)") }
	static func dashboard(_ id: String) -> URL { AppConfig.webURL("/dashboards/\(id)") }
}
