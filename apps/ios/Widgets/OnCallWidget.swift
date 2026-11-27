import AppIntents
import MapleWidgetData
import SwiftUI
import WidgetKit

/// Where you stand on call, for the organization the app last showed. Every
/// entry of the timeline is drawn from one signed read (`WidgetOnCallClient`),
/// so a handoff shows on the widget when it happens, with no reload.
struct OnCallWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(
			kind: OnCallWidgetKind.identifier,
			intent: OnCallConfigurationIntent.self,
			provider: OnCallProvider()
		) { entry in
			OnCallWidgetView(entry: entry)
				.containerBackground(Token.background, for: .widget)
		}
		.configurationDisplayName("On call")
		.description("Whether you are on call, until when, and who is on call now.")
		.supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
	}
}

/// Nothing to configure: the widget follows the organization on screen in the
/// app. An intent rather than a static configuration so the provider's
/// functions are async.
struct OnCallConfigurationIntent: WidgetConfigurationIntent {
	static let title: LocalizedStringResource = "On call"
	static let description = IntentDescription("Shows whether you are on call.")
}

struct OnCallEntry: TimelineEntry {
	var date: Date
	/// Nil until anything has been read: a fresh install, or the widget added
	/// before signing in.
	var snapshot: OnCallSnapshot?
	var organizationId: String?
	/// The credential was refused and only the app can register it again.
	var needsApp = false
	var isPlaceholder = false
}

/// What both on-call widgets do when WidgetKit asks for a timeline: read if it
/// is worth it, and say when to come back.
enum OnCallTimeline {
	/// Rotations move slowly, and the two kinds are woken together: the second
	/// draws from what the first just read.
	private static let freshFor: TimeInterval = 5 * 60

	struct Read {
		var needsApp: Bool
		var refreshDate: Date
	}

	/// As with the other widgets the read enriches the timeline and never gates
	/// it: a failure costs freshness, nothing else.
	static func read(organizationId: String?, now: Date) async -> Read {
		guard let organizationId else {
			return Read(needsApp: false, refreshDate: WidgetTimelineSchedule.refreshDate(from: now))
		}
		let stored = WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId).load()
		let name = WidgetOrganizationIndex().load().first { $0.id == organizationId }?.name ?? stored?.organizationName
		let failures: Int
		switch await WidgetOnCallClient.shared.refresh(
			organizationId: organizationId, organizationName: name, freshFor: freshFor, now: now
		) {
		case .fetched, .noCredential:
			failures = 0
		case .needsApp:
			// Only the app can fix this, and it reloads the widget when it has.
			failures = .max
		case .failed:
			failures =
				WidgetSnapshotStore<OnCallReadRecord>.onCallRead(organizationId: organizationId).load()?.consecutiveFailures ?? 1
		}
		return Read(
			needsApp: failures == .max,
			refreshDate: WidgetTimelineSchedule.refreshDate(from: now, consecutiveFailures: failures)
		)
	}

	/// The server refused this organization's credential and the app has not replaced it.
	static func isRejected(_ organizationId: String) -> Bool {
		WidgetFetchStateStore().load(organizationId: organizationId).isCredentialRejected
	}
}

struct OnCallProvider: AppIntentTimelineProvider {
	private let index = WidgetOrganizationIndex()

	func placeholder(in context: Context) -> OnCallEntry {
		OnCallEntry(date: Date(), snapshot: .sample, isPlaceholder: true)
	}

	/// The gallery shows the widget with a shift on it, never its empty state.
	func snapshot(for configuration: OnCallConfigurationIntent, in context: Context) async -> OnCallEntry {
		var entry = makeEntry(at: Date())
		if context.isPreview, entry.snapshot == nil { entry.snapshot = .sample }
		return entry
	}

	private func makeEntry(at date: Date) -> OnCallEntry {
		guard let organizationId = index.activeOrganizationId else { return OnCallEntry(date: date) }
		return OnCallEntry(
			date: date,
			snapshot: WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId).load(),
			organizationId: organizationId,
			needsApp: OnCallTimeline.isRejected(organizationId)
		)
	}

	func timeline(for configuration: OnCallConfigurationIntent, in context: Context) async -> Timeline<OnCallEntry> {
		let now = Date()
		let read = await OnCallTimeline.read(organizationId: index.activeOrganizationId, now: now)
		var base = makeEntry(at: now)
		base.needsApp = base.needsApp || read.needsApp
		// One entry per handoff and per hour the coarse time left drops, all
		// drawn from the one snapshot.
		let entries = (base.snapshot?.timelineDates(from: now) ?? [now]).map { date -> OnCallEntry in
			var entry = base
			entry.date = date
			return entry
		}
		return Timeline(entries: entries, policy: .after(read.refreshDate))
	}
}
