import MapleAPI
import SwiftUI

/// The web sidebar's Analyze group on the phone: traces, logs and read-only
/// dashboards under one tab. The hub owns the stack and the segment; each
/// segment owns its query and results.
struct ExploreView: View {
	@Environment(AppNavigation.self) private var navigation
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

	var body: some View {
		@Bindable var navigation = navigation
		NavigationStack(path: $navigation.explorePath) {
			ZStack {
				Token.background.ignoresSafeArea()
				VStack(spacing: 0) {
					TabRootHeader(title: "Explore")
					UnderlineTabs(
						options: ExploreSegment.allCases.map { ($0, $0.title) },
						selection: $navigation.exploreSegment
					)
					.padding(.top, 12)
					// Keyed on the scope so an org or environment switch starts each
					// segment from a fresh query rather than showing stale rows.
					Group {
						switch navigation.exploreSegment {
						case .traces: TracesExploreView()
						case .logs: LogsExploreView()
						case .dashboards: DashboardsListView()
						}
					}
					.id(scope)
				}
			}
			.tabRootChrome()
			.mapleDestinations()
		}
	}
}
