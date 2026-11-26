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

/// One row of the picker.
public struct ScheduleEntity: AppEntity {
	/// The `onc_…` id, not the name: a schedule can be renamed, and a widget
	/// pinned to it has to survive that.
	public var id: String
	public var name: String?
	public var rotationSummary: String?

	public init(id: String, name: String?, rotationSummary: String? = nil) {
		self.id = id
		self.name = name
		self.rotationSummary = rotationSummary
	}

	init(_ schedule: OnCallSnapshot.Schedule) {
		self.init(id: schedule.id, name: schedule.name, rotationSummary: schedule.rotationSummary)
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
	public init() {}

	/// Resolving what a configured widget already holds. A schedule that has
	/// since been deleted still resolves, by id: dropping it would re-point the
	/// widget at another rotation without saying so. The widget says it is gone.
	public func entities(for identifiers: [String]) async throws -> [ScheduleEntity] {
		identifiers.map { identifier in
			OnCallSnapshot.stored(holding: identifier)?.schedule(id: identifier).map(ScheduleEntity.init)
				?? ScheduleEntity(id: identifier, name: nil)
		}
	}

	/// The list iOS shows in the picker: the schedules of the organization the
	/// app is in, in the server's order.
	public func suggestedEntities() async throws -> [ScheduleEntity] {
		guard let organizationId = WidgetOrganizationIndex().activeOrganizationId else { return [] }
		let snapshot = WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId).load()
		return (snapshot?.schedules ?? []).map(ScheduleEntity.init)
	}
}
