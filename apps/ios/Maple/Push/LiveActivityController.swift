import ActivityKit
import Foundation
import Maple
import MapleAPI
import MapleWidgetData
import Observation

/// Lock Screen Live Activities for critical incidents.
///
/// A Live Activity needs two APNs tokens that the ordinary notification token
/// cannot stand in for:
///
/// - the **push-to-start token**, one per install, which lets the server create
///   an activity on a locked phone that has not opened the app. It rides along
///   on the device registration (`PushRegistrar.sync`).
/// - the **update token**, one per running activity, which only exists once the
///   activity is running and is handed to the app rather than to the server —
///   so the app posts it back. Without it the activity would start and then
///   freeze on the numbers it started with.
///
/// Both are observed here, for the lifetime of the app, and both are best
/// effort: a phone that cannot run activities still gets every notification.
@MainActor
@Observable
final class LiveActivityController {
	static let shared = LiveActivityController()

	/// False when the user has turned Live Activities off for Maple, or the OS
	/// cannot run them. Shown in the notification settings sheet, because
	/// otherwise the feature is simply missing with no explanation.
	private(set) var areActivitiesEnabled = false
	/// Hex, once iOS has issued one. Nil on the simulator and before the first
	/// activity subscription settles.
	private(set) var pushToStartToken: String?
	/// Last failure posting a token, for the settings sheet.
	private(set) var lastError: String?

	private var context: Context?
	private var observers: [Task<Void, Never>] = []
	/// One pair of observation tasks per activity id, cancelled when it ends.
	private var activityObservers: [String: [Task<Void, Never>]] = [:]

	struct Context {
		var api: any MapleAPI
		var organizationId: String
	}

	private init() {}

	/// Called once the app knows who is signed in. The observation tasks are
	/// started on the first call and left running: activities outlive any one
	/// screen, and iOS delivers a push-to-start token whether or not anything is
	/// on screen to receive it.
	func configure(api: any MapleAPI, organizationId: String) {
		context = Context(api: api, organizationId: organizationId)
		refreshAuthorization()
		startObserving()
		// An org switch changes which org's incidents this phone should be told
		// about; the tokens are the same, but the server keys them per org.
		Task { await resubmitRunningActivities() }
	}

	func refreshAuthorization() {
		areActivitiesEnabled = ActivityAuthorizationInfo().areActivitiesEnabled
	}

	/// Sign-out: stop watching, and end anything still on the Lock Screen. A
	/// resolved-looking incident from an org the user just left is worse than an
	/// empty Lock Screen.
	func stop() async {
		observers.forEach { $0.cancel() }
		observers.removeAll()
		activityObservers.values.flatMap { $0 }.forEach { $0.cancel() }
		activityObservers.removeAll()
		for activity in Activity<IncidentActivityAttributes>.activities {
			await activity.end(nil, dismissalPolicy: .immediate)
		}
		context = nil
		pushToStartToken = nil
	}

	// MARK: Observation

	private func startObserving() {
		guard observers.isEmpty else { return }

		// The push-to-start token. iOS may reissue it at any time; the last one
		// wins and re-registers the device.
		observers.append(
			Task { [weak self] in
				for await data in Activity<IncidentActivityAttributes>.pushToStartTokenUpdates {
					guard let self else { return }
					await MainActor.run { self.pushToStartToken = Self.hex(data) }
				}
			}
		)

		// Activities started by a push arrive here, as do ones started locally.
		observers.append(
			Task { [weak self] in
				for await activity in Activity<IncidentActivityAttributes>.activityUpdates {
					guard let self else { return }
					await MainActor.run { self.observe(activity) }
				}
			}
		)

		// Anything already running from before this launch — the app was killed
		// while an incident was open, which is the normal case for a phone in a
		// pocket.
		for activity in Activity<IncidentActivityAttributes>.activities {
			observe(activity)
		}
	}

	private func observe(_ activity: Activity<IncidentActivityAttributes>) {
		guard activityObservers[activity.id] == nil else { return }
		let incidentId = activity.attributes.incidentId
		let organizationId = activity.attributes.organizationId

		// One card per incident. A critical incident starts an activity for
		// everyone, and a page can start one for the person paged: when both
		// reach the same phone the later one is taken down again.
		let isDuplicate = Activity<IncidentActivityAttributes>.activities.contains { other in
			other.id != activity.id && other.attributes.incidentId == incidentId
				&& activityObservers[other.id] != nil
		}
		if isDuplicate {
			let duplicateId = activity.id
			Task {
				// Looked up again rather than captured: an `Activity` is not
				// Sendable, and one fresh from the system's list may be awaited on.
				for running in Activity<IncidentActivityAttributes>.activities where running.id == duplicateId {
					await running.end(nil, dismissalPolicy: .immediate)
				}
			}
			return
		}
		// What a push cannot say: who has the incident and who is paged next.
		Task { await self.incidentChanged(incidentId: incidentId, to: nil) }

		let tokens = Task { [weak self] in
			for await data in activity.pushTokenUpdates {
				guard let self else { return }
				await self.submit(
					activityId: activity.id,
					incidentId: incidentId,
					organizationId: organizationId,
					pushToken: Self.hex(data)
				)
			}
		}

		let states = Task { [weak self] in
			for await state in activity.activityStateUpdates {
				guard let self else { return }
				switch state {
				case .dismissed, .ended:
					await self.forget(activityId: activity.id, incidentId: incidentId, organizationId: organizationId)
				// `stale` is still on screen — the content is old, not gone, and
				// the next push is what fixes it.
				case .active, .stale:
					break
				@unknown default:
					break
				}
			}
		}

		activityObservers[activity.id] = [tokens, states]
	}

	/// After an org switch: the tokens are unchanged, but the new org's server
	/// rows know nothing about them.
	private func resubmitRunningActivities() async {
		// Only the cards being watched. A second card for an incident is on its
		// way out, and the server keeps one token per phone and incident: sending
		// its token would route the updates to a card that is about to go.
		for activity in Activity<IncidentActivityAttributes>.activities where activityObservers[activity.id] != nil {
			guard let data = activity.pushToken else { continue }
			await submit(
				activityId: activity.id,
				incidentId: activity.attributes.incidentId,
				organizationId: activity.attributes.organizationId,
				pushToken: Self.hex(data)
			)
		}
	}

	// MARK: Who has the incident

	/// Bring the cards for an incident in step with it: who acknowledged, who
	/// the next escalation step pages and when. Pass the incident when it is
	/// already in hand (the answer to an Acknowledge), or nil to read it.
	///
	/// The app does this because the server's pushes carry only the numbers, and
	/// a content state replaces the previous one whole: the next push drops
	/// these fields again, which reads as "unacknowledged, nothing known about
	/// the next page" until the app next runs.
	func incidentChanged(incidentId: String, to known: AlertIncident?) async {
		let running = Activity<IncidentActivityAttributes>.activities
			.filter { $0.attributes.incidentId == incidentId }
			.map { (id: $0.id, organizationId: $0.attributes.organizationId) }
		guard let first = running.first else { return }
		let session = PushRegistrar.shared.opener?.session
		var incident = known
		if incident == nil, let api = session?.api {
			incident = try? await Self.api(api, for: first.organizationId).alertIncident(id: incidentId)
		}
		guard let incident else { return }
		for card in running {
			await Self.show(incident, onActivity: card.id, viewerUserId: session?.currentUserId)
		}
	}

	/// Every running card, re-read. Called when the app comes to the front.
	func refreshRunningActivities() async {
		let incidentIds = Set(Activity<IncidentActivityAttributes>.activities.map(\.attributes.incidentId))
		for incidentId in incidentIds {
			await incidentChanged(incidentId: incidentId, to: nil)
		}
	}

	private static func show(_ incident: AlertIncident, onActivity activityId: String, viewerUserId: String?) async {
		// Looked up by id rather than passed in: an `Activity` is not Sendable,
		// and one fresh from the system's list may be awaited on.
		for activity in Activity<IncidentActivityAttributes>.activities where activity.id == activityId {
			var state = activity.content.state
			switch incident.responseState {
			case .resolved:
				// The end push was missed, or the incident was resolved by hand
				// from this phone: close the card the way the server would have.
				state.status = .resolved
				state.acknowledgedBy = nil
				state.nextPageAt = nil
				state.nextPagePeople = nil
				await activity.end(
					ActivityContent(state: state, staleDate: nil),
					dismissalPolicy: .after(Date().addingTimeInterval(Self.resolvedLinger))
				)
				continue
			case .acknowledged(let acknowledgement):
				state.acknowledgedBy = acknowledgement.by.label(viewerUserId: viewerUserId)
				state.nextPageAt = nil
				state.nextPagePeople = nil
			case .unacknowledged(let next):
				state.acknowledgedBy = nil
				state.nextPageAt = next?.at
				state.nextPagePeople = next?.peopleSummary(viewerUserId: viewerUserId)
			}
			guard state != activity.content.state else { continue }
			// Stale once the next page is due: the card then stops claiming a
			// countdown it can no longer keep.
			await activity.update(
				ActivityContent(state: state, staleDate: state.nextPageAt ?? activity.content.staleDate)
			)
		}
	}

	/// How long a resolved card stays before it clears itself, as after the
	/// server's own end push.
	private static let resolvedLinger: TimeInterval = 5 * 60

	// MARK: Fixtures

	/// Starts an activity locally, with sample content, for fixture mode.
	///
	/// The real path is push-to-start, which the simulator cannot receive — so
	/// without this the Lock Screen card can only be looked at on a device with
	/// a live incident, which is not a way to design one. Never reachable in a
	/// real session: the button that calls it is behind `FixtureAPI.isEnabled`.
	func startPreviewActivity() {
		guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
		// The fixture's own paging incident, so Acknowledge on the card goes
		// through the same fixture log the app's screens read.
		var attributes = IncidentActivityAttributes.sample
		attributes.incidentId = "inc_checkout_now"
		attributes.organizationId = nil
		attributes.startedAt = Date().addingTimeInterval(-161)
		_ = try? Activity.request(
			attributes: attributes,
			content: ActivityContent(
				state: .sample,
				staleDate: Date().addingTimeInterval(20 * 60)
			),
			// No push token: this one is driven by nothing and simply sits there.
			pushType: nil
		)
	}

	// MARK: Server

	/// Posting an activity's update token is what stops a Lock Screen card
	/// freezing on the numbers it started with. It fails silently by design, so
	/// the span is the only place that failure is ever recorded.
	private func submit(activityId: String, incidentId: String, organizationId: String?, pushToken: String) async {
		guard let context, let deviceToken = PushRegistrar.shared.deviceToken else { return }
		let api = Self.api(context.api, for: organizationId)
		await Telemetry.span(
			Telemetry.Name.liveActivitySubmit,
			attributes: [Telemetry.Key.liveActivityAction: .string("register")]
		) { span in
			await self.submit(
				api: api,
				deviceToken: deviceToken,
				activityId: activityId,
				incidentId: incidentId,
				pushToken: pushToken,
				span: span
			)
		}
	}

	private func submit(
		api: any MapleAPI,
		deviceToken: String,
		activityId: String,
		incidentId: String,
		pushToken: String,
		span: Span?
	) async {
		do {
			try await api.registerLiveActivity(
				deviceToken: deviceToken,
				incidentId: incidentId,
				activityId: activityId,
				pushToken: pushToken
			)
			lastError = nil
		} catch is CancellationError {
		} catch {
			// The activity keeps whatever content it started with rather than
			// updating — degraded, not broken, so nothing is torn down here.
			let apiError = error as? MapleAPIError
			lastError = apiError?.message ?? error.localizedDescription
			span?.setAttribute(Telemetry.Key.errorType, apiError?.telemetryType ?? "transport")
			span?.setStatus(.error(lastError ?? "live activity registration failed"))
		}
	}

	private func forget(activityId: String, incidentId: String, organizationId: String?) async {
		if let context, let deviceToken = PushRegistrar.shared.deviceToken {
			let api = Self.api(context.api, for: organizationId)
			await Telemetry.span(
				Telemetry.Name.liveActivityEnd,
				attributes: [Telemetry.Key.liveActivityAction: .string("end")]
			) { _ in
				try? await api.endLiveActivity(deviceToken: deviceToken, incidentId: incidentId)
			}
		}
		// After the request, not before: this cancels the task that is running
		// this very function, and a cancelled task cannot make a network call.
		activityObservers.removeValue(forKey: activityId)?.forEach { $0.cancel() }
	}

	/// The incident's own organization, and with it its region: the activity can
	/// belong to an organization other than the one on screen. Activities started
	/// before the payload named one fall back to the active organization.
	private static func api(_ api: any MapleAPI, for organizationId: String?) -> any MapleAPI {
		organizationId.map { api.scoped(to: $0) } ?? api
	}

	private static func hex(_ data: Data) -> String {
		data.map { String(format: "%02x", $0) }.joined()
	}
}
