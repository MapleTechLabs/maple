import SwiftUI

/// Pages on the web dashboard, for the "Open on web" buttons. The host follows
/// the API the app talks to (`AppConfig.webBaseURL`), so EU and previews match.
enum MapleWeb {
	static func service(_ name: String) -> URL { AppConfig.webURL("/services/\(name)") }
	static func issue(_ id: String) -> URL { AppConfig.webURL("/errors/issues/\(id)") }
	static func incident(_ id: String) -> URL { AppConfig.webURL("/alerts/incidents/\(id)") }
	static func trace(_ id: String) -> URL { AppConfig.webURL("/traces/\(id)") }
	static func dashboard(_ id: String) -> URL { AppConfig.webURL("/dashboards/\(id)") }
}

/// Opens a page on the web dashboard: a toolbar glyph, a bordered `Web` action,
/// or a menu item, all labelled "Open on web".
struct OpenOnWebButton: View {
	enum Style {
		case toolbar
		case action
		case menuItem
	}

	static let label = "Open on web"

	let url: URL
	var style: Style = .toolbar

	var body: some View {
		Link(destination: url) {
			switch style {
			case .toolbar:
				PixelIcon.externalLink.image
					.resizable()
					.frame(width: 16, height: 16)
					.foregroundStyle(Token.mutedForeground)
			case .action:
				AlertActionLabel(title: "Web", icon: .externalLink)
			case .menuItem:
				Label { Text(Self.label) } icon: { PixelIcon.externalLink.image }
			}
		}
		.accessibilityLabel(Self.label)
	}
}
