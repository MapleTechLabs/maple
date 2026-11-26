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
	enum Reason {
		/// The app came to the front. Happens on every app switch and unlock, so
		/// it is held to one read a minute, as the other widgets' publisher is.
		case foreground
		/// Something that moves the answer: a push, an incident answered in the
		/// app, a switch of organization. Always read.
		case changed
	}

	private static let minimumInterval: TimeInterval = 60
	private static var lastRefreshedAt: [String: Date] = [:]

	static func refresh(session: SessionController, reason: Reason = .changed) async {
		guard let organizationId = session.currentOrganizationId else { return }
		let now = Date()
		if reason == .foreground, let last = lastRefreshedAt[organizationId],
			now.timeIntervalSince(last) < minimumInterval
		{
			return
		}
		lastRefreshedAt[organizationId] = now
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
