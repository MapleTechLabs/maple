import Foundation
import MapleAPI
import MapleWidgetData
import WidgetKit

/// Keeps the Pages widget in step with what the app knows.
///
/// The widget reads for itself, but only when WidgetKit rebuilds its timeline,
/// which iOS meters. The app runs this whenever it has a reason to believe the
/// answer changed: it came to the front, a push arrived, or an incident was
/// answered on one of its own screens. It reads through the same signed client
/// the widget uses, so both write one shape into the App Group.
@MainActor
enum PagesWidgetPublisher {
	static func refresh(session: SessionController) async {
		guard let organizationId = session.currentOrganizationId else { return }
		if FixtureAPI.isEnabled {
			await publishFixture(api: session.api, organizationId: organizationId)
		} else {
			_ = await WidgetPagesClient.shared.refresh(
				organizationId: organizationId,
				organizationName: session.name(of: organizationId)
			)
		}
		WidgetCenter.shared.reloadTimelines(ofKind: PagesWidgetKind.identifier)
	}

	/// Fixture mode has no server and no credential, so the snapshot is written
	/// from the fixture incidents: this is how the widget gets designed and
	/// screenshotted. Its Acknowledge cannot land there, and says so.
	private static func publishFixture(api: any MapleAPI, organizationId: String) async {
		guard let incidents = try? await api.alertIncidentsPagingMe(limit: 10) else { return }
		let pages = incidents.map { incident -> PagesSnapshot.Page in
			let unit = SignalDisplay(signal: incident.signalType).unit
			var page = PagesSnapshot.Page(
				id: incident.id,
				ruleName: incident.ruleName,
				group: incident.id == "inc_checkout_now" ? "checkout-api" : nil,
				isCritical: incident.severity == .critical,
				value: unit.format(incident.lastObservedValue),
				threshold: "\(incident.comparator.glyph) \(unit.format(incident.threshold))",
				openedAt: ResolvedTimeWindow.parse(incident.firstTriggeredAt) ?? Date()
			)
			switch incident.responseState {
			case .unacknowledged(let next):
				page.nextPageAt = next?.at
				page.nextPagePeople = next?.peopleSummary(viewerUserId: FixtureSession.userId)
			case .acknowledged(let acknowledgement):
				page.acknowledgedBy = acknowledgement.by.name ?? "a teammate"
				page.acknowledgedByYou = acknowledgement.by.userId == FixtureSession.userId
			case .resolved:
				break
			}
			return page
		}
		var snapshot = PagesSnapshot(
			generatedAt: Date(),
			organizationId: organizationId,
			organizationName: FixtureSession.organizationName,
			hasMore: false,
			pages: pages.filter(\.awaitsAcknowledgement) + pages.filter { !$0.awaitsAcknowledgement }
		)
		snapshot.isFixture = true
		WidgetSnapshotStore<PagesSnapshot>.pages(organizationId: organizationId).save(snapshot)
	}
}
