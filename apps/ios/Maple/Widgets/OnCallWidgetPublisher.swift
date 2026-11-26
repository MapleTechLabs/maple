import Foundation
import MapleAPI
import MapleWidgetData
import WidgetKit

/// Keeps the On call and Schedule widgets in step with what the app knows.
/// The widgets read for themselves only when iOS rebuilds their timelines, so
/// the app reads through the same signed client when it has a reason to.
@MainActor
enum OnCallWidgetPublisher {
	enum Reason {
		/// The app came to the front. Happens on every app switch and unlock, so
		/// it is held to one read a minute, as the Pages publisher is.
		case foreground
		/// A switch of organization, or a new session. Always read.
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
		let store = WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId)
		let shiftBefore = store.load()?.pagesShiftLine(at: now)
		if FixtureAPI.isEnabled {
			await publishFixture(api: session.api, organizationId: organizationId)
		} else {
			_ = await WidgetOnCallClient.shared.refresh(
				organizationId: organizationId,
				organizationName: session.name(of: organizationId)
			)
		}
		WidgetCenter.shared.reloadTimelines(ofKind: OnCallWidgetKind.identifier)
		WidgetCenter.shared.reloadTimelines(ofKind: ScheduleWidgetKind.identifier)
		// The Pages widget names the owner's shift when nothing is paging, and
		// only needs telling when that line is a different one.
		if store.load()?.pagesShiftLine(at: now) != shiftBefore {
			WidgetCenter.shared.reloadTimelines(ofKind: PagesWidgetKind.identifier)
		}
	}

	/// Fixture mode has no server and no credential, so the snapshot is written
	/// from the fixture overview: this is how the widgets get designed and
	/// screenshotted.
	private static func publishFixture(api: any MapleAPI, organizationId: String) async {
		guard let overview = try? await api.onCallOverview(),
			let snapshot = OnCallSnapshot(
				overview: overview, organizationId: organizationId, organizationName: FixtureSession.organizationName
			)
		else { return }
		WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId).save(snapshot)
	}
}

extension OnCallSnapshot {
	/// The generated overview in the widgets' shape. Only fixture mode uses it:
	/// a signed-in app stores what `WidgetOnCallClient` read, as the widgets do.
	fileprivate init?(overview: OnCallOverview, organizationId: String, organizationName: String?) {
		guard let generatedAt = ResolvedTimeWindow.parse(overview.generatedAt), let windowEnd = overview.windowEnd
		else { return nil }
		func shift(_ period: OnCallPeriod) -> Shift {
			Shift(
				userId: period.userId, start: period.start, end: period.end, isOverride: period.isOverride,
				continues: period.continues
			)
		}
		self.init(
			generatedAt: generatedAt,
			organizationId: organizationId,
			organizationName: organizationName,
			userId: overview.userId,
			windowEnd: windowEnd,
			schedules: overview.schedules.map { schedule in
				Schedule(
					id: schedule.id,
					name: schedule.name,
					rotationSummary: schedule.rotationSummary,
					onCallNow: schedule.onCallNow?.period.map(shift),
					next: schedule.next?.period.map(shift),
					shifts: schedule.periods.map(shift),
					gaps: schedule.coverageGaps.compactMap { gap in
						guard let start = ResolvedTimeWindow.parse(gap.startsAt),
							let end = ResolvedTimeWindow.parse(gap.endsAt), end > start
						else { return nil }
						return Gap(start: start, end: end)
					}
				)
			},
			// Every shift it was sent, not only those still ahead: the widgets
			// decide that at each entry's date.
			myShifts: overview.viewerShifts(now: .distantPast).map {
				ViewerShift(
					scheduleId: $0.scheduleId, scheduleName: $0.scheduleName, start: $0.start, end: $0.end,
					isOverride: $0.isOverride, continues: $0.continues
				)
			},
			people: overview.people.map { Person(userId: $0.userId, name: $0.name) }
		)
	}
}
