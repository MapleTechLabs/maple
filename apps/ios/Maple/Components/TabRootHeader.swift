import SwiftUI

/// The line under a tab root's title: `● 1 critical alert · 2 of 14 services degraded`.
struct TabRootStatus: Equatable {
	/// The dot's colour; nil draws no dot.
	var dot: Color?
	/// Foreground lead, such as `1 critical alert`. May be empty.
	var lead: String
	/// Muted remainder, such as `· 2 of 14 services degraded`.
	var detail: String
}

/// The top of every tab root: organization and environment pills, then the
/// page title. It scrolls with the content, as on the web.
struct TabRootHeader: View {
	let title: String
	var status: TabRootStatus? = nil

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack {
				OrganizationSwitcherButton()
				Spacer(minLength: 8)
				EnvironmentPickerView()
			}
			.frame(height: 52)
			VStack(alignment: .leading, spacing: 6) {
				Text(title)
					.font(Typo.pageTitle)
					.tracking(-0.6)
					.foregroundStyle(Token.foreground)
					.accessibilityAddTraits(.isHeader)
				if let status {
					HStack(spacing: 8) {
						if let dot = status.dot {
							Circle().fill(dot).frame(width: 8, height: 8)
						}
						(Text(status.lead).foregroundStyle(Token.foreground)
							+ Text(status.lead.isEmpty ? status.detail : " \(status.detail)")
							.foregroundStyle(Token.mutedForeground))
							.font(Typo.small)
							.lineLimit(2)
					}
				}
			}
			.padding(.top, 8)
		}
		.padding(.horizontal, 16)
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

extension View {
	/// A tab root draws its own header in the scroll content, so the system bar
	/// stays hidden there and returns on pushed screens. A background band under
	/// the status bar keeps scrolled content from running beneath the clock.
	func tabRootChrome() -> some View {
		toolbar(.hidden, for: .navigationBar)
			.safeAreaInset(edge: .top, spacing: 0) {
				Color.clear.frame(height: 0).background(Token.background)
			}
	}
}
