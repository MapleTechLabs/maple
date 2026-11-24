import SwiftUI

/// Pages on the web dashboard, for the "Open on web" buttons. The host is the
/// dashboard of the organization's region (`SessionController.web`).
struct MapleWeb {
	let baseURL: URL

	func service(_ name: String) -> URL { baseURL.appending(path: "/services/\(name)") }
	func issue(_ id: String) -> URL { baseURL.appending(path: "/errors/issues/\(id)") }
	func incident(_ id: String) -> URL { baseURL.appending(path: "/alerts/incidents/\(id)") }
	func trace(_ id: String) -> URL { baseURL.appending(path: "/traces/\(id)") }
	func dashboard(_ id: String) -> URL { baseURL.appending(path: "/dashboards/\(id)") }
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
