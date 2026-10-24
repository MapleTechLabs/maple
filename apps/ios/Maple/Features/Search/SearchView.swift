import SwiftUI

/// Search across services, issues and trace ids. Placeholder until the screen
/// lands with the rest of the rework.
struct SearchView: View {
	var body: some View {
		NavigationStack {
			Token.background.ignoresSafeArea()
				.mapleScreen(Screen.search)
		}
	}
}
