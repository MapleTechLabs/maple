import MapleAPI
import SwiftUI

/// The triage hub: incidents, error issues, and anomalies under one tab with a
/// segmented switch. Each segment owns its data and its toolbar; the hub owns
/// the stack and the segment.
struct AlertsHubView: View {
	@Environment(AppNavigation.self) private var navigation
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@State private var models: AlertsHubModels?

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

	var body: some View {
		@Bindable var navigation = navigation
		NavigationStack(path: $navigation.alertsPath) {
			ZStack {
				Token.background.ignoresSafeArea()
				VStack(spacing: 0) {
					TabRootHeader(title: "Triage")
					UnderlineTabs(
						options: AlertsSegment.allCases.map { ($0, $0.title) },
						selection: $navigation.alertsSegment,
						badge: { models?.badge(for: $0) }
					)
					.padding(.top, 12)
					if let models {
						switch navigation.alertsSegment {
						case .incidents: IncidentsListView(model: models.incidents)
						case .errors: IssuesListContent(model: models.issues)
						case .anomalies: AnomaliesListView(model: models.anomalies)
						}
					} else {
						// One frame, before the models exist: the same skeleton
						// the segment renders itself.
						ScrollView { SkeletonList(rowHeight: segmentRowHeight) }
					}
				}
			}
			// Hidden on the root; it names the back button on pushed screens.
			.navigationTitle("Triage")
			.tabRootChrome()
			.mapleDestinations()
		}
		// Re-runs on an org switch or an environment change, replacing all three
		// models at once so no segment shows one scope's rows under the next
		// scope's title.
		.task(id: scope) {
			if models?.scope != scope {
				models = AlertsHubModels(session: session, scope: scope)
			}
		}
	}

	private var segmentRowHeight: CGFloat {
		switch navigation.alertsSegment {
		case .incidents: 72
		case .errors: 84
		case .anomalies: 64
		}
	}
}

/// The three segments' models, owned by the hub rather than by the segment
/// views. A segment view is rebuilt on every switch (it's a `switch` in the
/// hub's body), and when the model lived in the view as `@State` it went with
/// it — so Incidents → Errors → Incidents refetched and showed a skeleton
/// each time. Each segment loads lazily on first appearance.
@MainActor
@Observable
final class AlertsHubModels {
	let incidents: IncidentsListModel
	let issues: IssuesListModel
	let anomalies: AnomaliesListModel
	let scope: SessionController.DataScope

	/// The scope's environment reaches issues and anomalies, whose endpoints
	/// take the filter, and is ignored by incidents, whose endpoints do not —
	/// the scoped client is still handed to all three so the day `/v2/alerts`
	/// grows the parameter, this segment starts honouring it without another
	/// change here.
	init(session: SessionController, scope: SessionController.DataScope) {
		let api = session.api.scoped(toEnvironment: scope.environment)
		incidents = IncidentsListModel(api: api, session: session)
		issues = IssuesListModel(api: api, session: session)
		anomalies = AnomaliesListModel(api: api, session: session)
		self.scope = scope
	}

	/// The segment's count once its first load has answered; nil before, so a
	/// label never shows a number that is not real yet. Alerts turn red when open.
	func badge(for segment: AlertsSegment) -> UnderlineTabBadge? {
		switch segment {
		case .errors:
			guard let count = Self.count(issues.state) else { return nil }
			return UnderlineTabBadge(text: issues.canLoadMore ? "\(count)+" : "\(count)")
		case .incidents:
			guard let count = Self.count(incidents.state) else { return nil }
			return UnderlineTabBadge(text: "\(count)", tint: count > 0 ? Token.destructive : Token.mutedForeground)
		case .anomalies:
			guard let count = Self.count(anomalies.state) else { return nil }
			return UnderlineTabBadge(text: "\(count)")
		}
	}

	private static func count<Element>(_ state: LoadState<[Element]>) -> Int? {
		switch state {
		case .loaded(let items): items.count
		case .empty: 0
		case .loading, .failed: nil
		}
	}
}
