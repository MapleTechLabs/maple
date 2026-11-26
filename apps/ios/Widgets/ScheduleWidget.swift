import AppIntents
import MapleWidgetData
import SwiftUI
import WidgetKit

/// One on-call rotation over the next seven days, picked in the widget's own
/// configuration (`SelectScheduleIntent`). It draws from the same snapshot as
/// the On call widget and makes the same read.
struct ScheduleWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(
			kind: ScheduleWidgetKind.identifier,
			intent: SelectScheduleIntent.self,
			provider: ScheduleProvider()
		) { entry in
			ScheduleWidgetView(entry: entry)
				.containerBackground(Token.background, for: .widget)
		}
		.configurationDisplayName("Schedule")
		.description("One on-call schedule: who has it now and over the next seven days.")
		.supportedFamilies([.systemMedium])
	}
}

struct ScheduleEntry: TimelineEntry {
	var date: Date
	var snapshot: OnCallSnapshot?
	/// The schedule picked in the configuration, or nil for the default.
	var pickedId: String?
	/// The organization whose snapshot is on screen, carried into the deep link.
	var organizationId: String?
	/// The credential was refused and only the app can register it again.
	var needsApp = false
	var isPlaceholder = false

	/// The schedule to draw at this entry's date. An unpicked widget follows the
	/// owner from one rotation to the next as their shifts change.
	func schedule(in snapshot: OnCallSnapshot) -> OnCallSnapshot.Schedule? {
		if let pickedId { return snapshot.schedule(id: pickedId) }
		return snapshot.defaultSchedule(at: date)
	}
}

struct ScheduleProvider: AppIntentTimelineProvider {
	private let index = WidgetOrganizationIndex()

	func placeholder(in context: Context) -> ScheduleEntry {
		ScheduleEntry(date: Date(), snapshot: .sample, isPlaceholder: true)
	}

	/// The gallery shows a rotation, never the empty state.
	func snapshot(for configuration: SelectScheduleIntent, in context: Context) async -> ScheduleEntry {
		var entry = makeEntry(for: configuration, at: Date())
		if context.isPreview, entry.snapshot == nil {
			entry.snapshot = .sample
			entry.pickedId = nil
		}
		return entry
	}

	private func makeEntry(for configuration: SelectScheduleIntent, at date: Date) -> ScheduleEntry {
		let pickedId = configuration.schedule?.id
		// A picked schedule is read from the organization that holds it, which
		// need not be the one the app is in. No other organization's schedule
		// is ever shown in its place.
		let held = pickedId.flatMap { OnCallSnapshot.stored(holding: $0) }
		let active = index.activeOrganizationId
		let snapshot = held ?? active.flatMap { WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: $0).load() }
		let organizationId = snapshot?.organizationId ?? active
		return ScheduleEntry(
			date: date,
			snapshot: snapshot,
			pickedId: pickedId,
			organizationId: organizationId,
			needsApp: organizationId.map(OnCallTimeline.isRejected) ?? false
		)
	}

	func timeline(for configuration: SelectScheduleIntent, in context: Context) async -> Timeline<ScheduleEntry> {
		let now = Date()
		let read = await OnCallTimeline.read(organizationId: makeEntry(for: configuration, at: now).organizationId, now: now)
		var base = makeEntry(for: configuration, at: now)
		base.needsApp = base.needsApp || read.needsApp
		// Each handoff moves the line under the title, and each midnight the strip.
		let entries = (base.snapshot?.timelineDates(from: now) ?? [now]).map { date -> ScheduleEntry in
			var entry = base
			entry.date = date
			return entry
		}
		return Timeline(entries: entries, policy: .after(read.refreshDate))
	}
}
