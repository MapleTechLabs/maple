import AppIntents
import Foundation

/// The Pages widget's Acknowledge button.
///
/// Unlike the Live Activity's, this one is performed in the widget extension,
/// which has no session: it signs the request with the device credential the
/// app registered, and that credential can reach this one write and nothing
/// else. WidgetKit reloads the widget's timeline once `perform` returns, and
/// the timeline reads the snapshot this wrote.
public struct AcknowledgePageIntent: AppIntent {
	public static let title: LocalizedStringResource = "Acknowledge page"
	public static let description = IntentDescription("Acknowledges an incident that is paging you.")
	/// Not something to offer in Shortcuts: it only means anything on its row.
	public static let isDiscoverable = false

	@Parameter(title: "Incident")
	public var incidentId: String

	@Parameter(title: "Organization")
	public var organizationId: String

	public init() {}

	public init(incidentId: String, organizationId: String) {
		self.incidentId = incidentId
		self.organizationId = organizationId
	}

	public func perform() async throws -> some IntentResult {
		let client = WidgetPagesClient.shared
		let store = WidgetSnapshotStore<PagesSnapshot>.pages(organizationId: organizationId)
		switch await client.acknowledge(organizationId: organizationId, incidentId: incidentId) {
		case .acknowledged:
			break
		case .nothingToAnswer:
			// Resolved since the widget drew it: read again so the row goes.
			_ = await client.refresh(organizationId: organizationId, organizationName: store.load()?.organizationName)
		case .needsApp, .failed:
			// The row stays as it was, and says the tap did not land.
			if var snapshot = store.load() {
				snapshot.unansweredTap = incidentId
				store.save(snapshot)
			}
		}
		return .result()
	}
}
