import AppIntents
import Foundation

/// The Schedule widget's configuration: which rotation it shows. Unset is a
/// real answer: the widget then shows the schedule its owner is on call for,
/// else the first, so it says something the moment it is added.
public struct SelectScheduleIntent: WidgetConfigurationIntent {
	public static let title: LocalizedStringResource = "Select schedule"
	public static let description = IntentDescription("Show one on-call schedule's next seven days.")

	@Parameter(title: "Schedule")
	public var schedule: ScheduleEntity?

	public init() {}

	public init(schedule: ScheduleEntity?) {
		self.schedule = schedule
	}
}

/// What a configured Schedule widget keeps: the schedule and the organization
/// it belongs to, in one identifier. With both, the widget finds its rotation
/// again when no snapshot is on disk to look the organization up in, as after
/// a sign-out.
public struct SchedulePick: Hashable, Sendable {
	/// The `onc_…` id, not the name: a schedule can be renamed, and a widget
	/// pinned to it has to survive that.
	public var scheduleId: String
	/// Nil for a pick made before picks carried one.
	public var organizationId: String?

	private static let separator: Character = "/"

	public init(scheduleId: String, organizationId: String?) {
		self.scheduleId = scheduleId
		self.organizationId = organizationId
	}

	/// "org_2abc/onc_platform", or the bare schedule id of an older pick.
	public init(identifier: String) {
		let parts = identifier.split(separator: Self.separator, maxSplits: 1, omittingEmptySubsequences: false)
		if parts.count == 2, WidgetCredentialStore.isSafeOrganizationId(String(parts[0])), !parts[1].isEmpty {
			self.init(scheduleId: String(parts[1]), organizationId: String(parts[0]))
		} else {
			self.init(scheduleId: identifier, organizationId: nil)
		}
	}

	public var identifier: String {
		organizationId.map { "\($0)\(Self.separator)\(scheduleId)" } ?? scheduleId
	}

	/// The organization a Schedule widget reads and refreshes. A pick's own,
	/// whichever the app is in: the active one never stands in for it. An older
	/// pick is looked up in the snapshots, and nothing picked follows the app.
	public static func organizationId(
		showing pick: SchedulePick?, appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> String? {
		let active = WidgetOrganizationIndex(appGroupIdentifier: appGroupIdentifier).activeOrganizationId
		guard let pick else { return active }
		if let pinned = pick.organizationId { return pinned }
		return OnCallSnapshot.stored(holding: pick.scheduleId, appGroupIdentifier: appGroupIdentifier)?.organizationId
			?? active
	}
}

/// One row of the picker.
public struct ScheduleEntity: AppEntity {
	public var scheduleId: String
	/// The organization the schedule was picked in. Nil on an older pick.
	public var organizationId: String?
	public var name: String?
	public var rotationSummary: String?

	/// What iOS stores for a configured widget, so it carries both ids.
	public var id: String { pick.identifier }
	public var pick: SchedulePick { SchedulePick(scheduleId: scheduleId, organizationId: organizationId) }

	public init(pick: SchedulePick, name: String?, rotationSummary: String? = nil) {
		self.scheduleId = pick.scheduleId
		self.organizationId = pick.organizationId
		self.name = name
		self.rotationSummary = rotationSummary
	}

	init(_ schedule: OnCallSnapshot.Schedule, pick: SchedulePick) {
		self.init(pick: pick, name: schedule.name, rotationSummary: schedule.rotationSummary)
	}

	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Schedule")
	public static let defaultQuery = ScheduleEntityQuery()

	public var displayRepresentation: DisplayRepresentation {
		guard let rotationSummary, !rotationSummary.isEmpty else {
			return DisplayRepresentation(title: "\(name ?? "Schedule")")
		}
		return DisplayRepresentation(title: "\(name ?? "Schedule")", subtitle: "\(rotationSummary)")
	}
}

/// The options come from the on-call snapshot in the App Group: the extension
/// has no session to list schedules with, and the snapshot is the list the
/// widget can draw.
public struct ScheduleEntityQuery: EntityQuery {
	/// The App Group the snapshots are read from. Only tests point it elsewhere.
	private let appGroupIdentifier: String

	init(appGroupIdentifier: String) {
		self.appGroupIdentifier = appGroupIdentifier
	}

	public init() {
		self.init(appGroupIdentifier: WidgetAppGroup.identifier)
	}

	/// Resolving what a configured widget already holds, from the identifier
	/// alone: after a sign-out there is no snapshot, and the pick must not move.
	/// A schedule that has since been deleted still resolves too: dropping it
	/// would re-point the widget at another rotation without saying so.
	public func entities(for identifiers: [String]) async throws -> [ScheduleEntity] {
		identifiers.map { identifier in
			let pick = SchedulePick(identifier: identifier)
			let snapshot =
				if let organizationId = pick.organizationId {
					WidgetSnapshotStore<OnCallSnapshot>
						.onCall(organizationId: organizationId, appGroupIdentifier: appGroupIdentifier).load()
				} else {
					OnCallSnapshot.stored(holding: pick.scheduleId, appGroupIdentifier: appGroupIdentifier)
				}
			return snapshot?.schedule(id: pick.scheduleId).map { ScheduleEntity($0, pick: pick) }
				?? ScheduleEntity(pick: pick, name: nil)
		}
	}

	/// The list iOS shows in the picker: the schedules of the organization the
	/// app is in, in the server's order, each remembering that organization.
	public func suggestedEntities() async throws -> [ScheduleEntity] {
		let index = WidgetOrganizationIndex(appGroupIdentifier: appGroupIdentifier)
		guard let organizationId = index.activeOrganizationId else { return [] }
		let snapshot = WidgetSnapshotStore<OnCallSnapshot>
			.onCall(organizationId: organizationId, appGroupIdentifier: appGroupIdentifier).load()
		return (snapshot?.schedules ?? []).map {
			ScheduleEntity($0, pick: SchedulePick(scheduleId: $0.id, organizationId: organizationId))
		}
	}
}
