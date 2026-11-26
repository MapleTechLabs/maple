import AppIntents
import MapleWidgetData
import SwiftUI
import WidgetKit

/// What is paging you, on the Home Screen and the Lock Screen, with Acknowledge
/// on the widget.
///
/// It follows the organization the app last showed. The extension reads with
/// the device credential the app registered (`WidgetPagesClient`), and falls
/// back to the snapshot in the App Group, which the app also writes whenever an
/// incident is answered inside it.
struct PagesWidget: Widget {
	var body: some WidgetConfiguration {
		AppIntentConfiguration(
			kind: PagesWidgetKind.identifier,
			intent: PagesConfigurationIntent.self,
			provider: PagesProvider()
		) { entry in
			PagesWidgetView(entry: entry)
				.containerBackground(Token.background, for: .widget)
		}
		.configurationDisplayName("Pages")
		.description("What is paging you right now, with Acknowledge on the widget.")
		.supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
	}
}

/// Nothing to configure yet: the widget follows the organization on screen in
/// the app. An intent rather than a static configuration so the provider's
/// functions are async.
struct PagesConfigurationIntent: WidgetConfigurationIntent {
	static let title: LocalizedStringResource = "Pages"
	static let description = IntentDescription("Shows what is paging you.")
}

struct PagesEntry: TimelineEntry {
	var date: Date
	/// Nil until anything has been read: a fresh install, or the widget added
	/// before signing in.
	var snapshot: PagesSnapshot?
	var organizationId: String?
	/// The registered credential may acknowledge. Without it a row opens the
	/// incident instead of offering a button that would be refused.
	var canAcknowledge = false
	/// The credential was refused and only the app can register it again.
	var needsApp = false
	var isPlaceholder = false
	/// The last on-call read for the same organization, when there is one. Only
	/// the quiet state uses it, to say whose shift it is.
	var onCall: OnCallSnapshot?

	var shiftLine: String? { onCall?.pagesShiftLine(at: date) }
}

struct PagesProvider: AppIntentTimelineProvider {
	private let index = WidgetOrganizationIndex()

	/// A page waiting on an answer is worth the refresh budget; a quiet widget is not.
	private static let waitingRefresh: TimeInterval = 5 * 60
	private static let quietRefresh: TimeInterval = 20 * 60

	func placeholder(in context: Context) -> PagesEntry {
		PagesEntry(date: Date(), snapshot: .sample, canAcknowledge: true, isPlaceholder: true)
	}

	/// The gallery shows the widget with something to say, never its empty state.
	func snapshot(for configuration: PagesConfigurationIntent, in context: Context) async -> PagesEntry {
		var entry = makeEntry(at: Date())
		if context.isPreview, entry.snapshot == nil {
			entry.snapshot = .sample
			entry.canAcknowledge = true
		}
		return entry
	}

	private func makeEntry(at date: Date) -> PagesEntry {
		guard let organizationId = index.activeOrganizationId else { return PagesEntry(date: date) }
		let snapshot = WidgetSnapshotStore<PagesSnapshot>.pages(organizationId: organizationId).load()
		return PagesEntry(
			date: date,
			snapshot: snapshot,
			organizationId: organizationId,
			canAcknowledge: snapshot?.isFixture == true
				|| WidgetPagesClient.shared.canAcknowledge(organizationId: organizationId, now: date),
			onCall: WidgetSnapshotStore<OnCallSnapshot>.onCall(organizationId: organizationId).load()
		)
	}

	/// Read if it can, then render. As with the other widgets the read enriches
	/// the timeline and never gates it: a failure costs freshness, nothing else.
	func timeline(for configuration: PagesConfigurationIntent, in context: Context) async -> Timeline<PagesEntry> {
		let now = Date()
		var base = makeEntry(at: now)
		if let organizationId = base.organizationId {
			let name = index.load().first { $0.id == organizationId }?.name
			switch await WidgetPagesClient.shared.refresh(organizationId: organizationId, organizationName: name, now: now) {
			case .fetched: base = makeEntry(at: now)
			case .needsApp: base.needsApp = true
			case .noCredential, .failed: break
			}
		}
		// One more entry just after each page comes due, so a countdown that has
		// run out is taken down rather than left at zero.
		var due = (base.snapshot?.waiting ?? [])
			.compactMap { $0.upcomingPage(at: now) }
			.map { $0.addingTimeInterval(1) }
		// And one where the owner's shift ends, so the quiet state stops naming it.
		if base.shiftLine != nil, case .onCall(let current)? = base.onCall?.viewerState(at: now) {
			due.append(current.until)
		}
		let entries = ([now] + due.sorted()).map { date -> PagesEntry in
			var entry = base
			entry.date = date
			return entry
		}
		let isWaiting = !(base.snapshot?.waiting.isEmpty ?? true)
		return Timeline(
			entries: entries,
			policy: .after(now.addingTimeInterval(isWaiting ? Self.waitingRefresh : Self.quietRefresh))
		)
	}
}
