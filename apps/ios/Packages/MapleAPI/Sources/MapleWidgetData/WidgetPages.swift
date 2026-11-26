import Foundation

/// The Pages widget: what is paging you, with Acknowledge on the widget.
public enum PagesWidgetKind {
	public static let identifier = "MaplePagesWidget"

	public static func incidentURL(id: String, organizationId: String?) -> URL? {
		WidgetDeepLink(target: .incident(id: id), organizationId: organizationId).url
	}

	public static func incidentsListURL(organizationId: String?) -> URL? {
		WidgetDeepLink(target: .incidentsList, organizationId: organizationId).url
	}
}

/// `GET /v2/widget_summary/pages`, decoded by hand like the summary: the
/// extension does not link the generated client.
public struct WidgetPagesPayload: Codable, Sendable, Equatable {
	public var generatedAt: Date
	public var organizationId: String
	public var hasMore: Bool
	public var data: [Page]

	public struct Page: Codable, Sendable, Equatable {
		public var incidentId: String
		public var ruleName: String
		public var group: String?
		public var severity: String
		public var value: String
		public var threshold: String
		public var openedAt: Date
		public var acknowledgedBy: String?
		public var acknowledgedByYou: Bool
		public var nextPageAt: Date?
		public var nextPagePeople: String?

		private enum CodingKeys: String, CodingKey {
			case incidentId = "incident_id"
			case ruleName = "rule_name"
			case group
			case severity
			case value
			case threshold
			case openedAt = "opened_at"
			case acknowledgedBy = "acknowledged_by"
			case acknowledgedByYou = "acknowledged_by_you"
			case nextPageAt = "next_page_at"
			case nextPagePeople = "next_page_people"
		}

		var page: PagesSnapshot.Page {
			.init(
				id: incidentId,
				ruleName: ruleName,
				group: group,
				isCritical: severity == "critical",
				value: value,
				threshold: threshold,
				openedAt: openedAt,
				acknowledgedBy: acknowledgedBy,
				acknowledgedByYou: acknowledgedByYou,
				nextPageAt: nextPageAt,
				nextPagePeople: nextPagePeople
			)
		}
	}

	private enum CodingKeys: String, CodingKey {
		case generatedAt = "generated_at"
		case organizationId = "organization_id"
		case hasMore = "has_more"
		case data
	}

	public func snapshot(organizationName: String?) -> PagesSnapshot {
		PagesSnapshot(
			generatedAt: generatedAt,
			organizationId: organizationId,
			organizationName: organizationName,
			hasMore: hasMore,
			pages: data.map(\.page)
		)
	}
}

/// What the Pages widget renders, as it sits in the App Group between a fetch
/// and the next timeline.
public struct PagesSnapshot: Codable, Sendable, Equatable {
	public var generatedAt: Date
	public var organizationId: String
	public var organizationName: String?
	/// More incidents are paging than `pages` carries.
	public var hasMore: Bool
	/// Unanswered first, as the server sends them.
	public var pages: [Page]
	/// The incident whose Acknowledge was tapped on the widget and did not land.
	/// Set by the intent, and gone with the next snapshot the server answers.
	public var unansweredTap: String?
	/// Written by the app's fixture mode, which has no server and registers no
	/// credential. The widget then draws the button a registered phone gets, so
	/// it can be designed and screenshotted; a tap there cannot land.
	public var isFixture: Bool?

	public struct Page: Codable, Sendable, Equatable, Identifiable {
		/// The public `inc_…` id.
		public var id: String
		public var ruleName: String
		public var group: String?
		public var isCritical: Bool
		/// Formatted by the server: "9.1%".
		public var value: String
		/// "> 5%".
		public var threshold: String
		public var openedAt: Date
		public var acknowledgedBy: String?
		public var acknowledgedByYou: Bool
		public var nextPageAt: Date?
		public var nextPagePeople: String?

		public init(
			id: String,
			ruleName: String,
			group: String?,
			isCritical: Bool,
			value: String,
			threshold: String,
			openedAt: Date,
			acknowledgedBy: String? = nil,
			acknowledgedByYou: Bool = false,
			nextPageAt: Date? = nil,
			nextPagePeople: String? = nil
		) {
			self.id = id
			self.ruleName = ruleName
			self.group = group
			self.isCritical = isCritical
			self.value = value
			self.threshold = threshold
			self.openedAt = openedAt
			self.acknowledgedBy = acknowledgedBy
			self.acknowledgedByYou = acknowledgedByYou
			self.nextPageAt = nextPageAt
			self.nextPagePeople = nextPagePeople
		}

		public var awaitsAcknowledgement: Bool { acknowledgedBy == nil }

		/// "Acknowledged by you", "Acknowledged by Dana Kim".
		public var acknowledgedLine: String? {
			acknowledgedBy.map { "Acknowledged by \(acknowledgedByYou ? "you" : $0)" }
		}

		/// The next page, while it is still ahead of `date`. Past it the step has
		/// run and only a fresh read can say what it did.
		public func upcomingPage(at date: Date) -> Date? {
			guard awaitsAcknowledgement, let nextPageAt, nextPageAt > date else { return nil }
			return nextPageAt
		}
	}

	public init(generatedAt: Date, organizationId: String, organizationName: String?, hasMore: Bool, pages: [Page]) {
		self.generatedAt = generatedAt
		self.organizationId = organizationId
		self.organizationName = organizationName
		self.hasMore = hasMore
		self.pages = pages
	}

	/// What is still waiting on an answer.
	public var waiting: [Page] { pages.filter(\.awaitsAcknowledgement) }

	/// "1 unacknowledged", "2 unacknowledged", with a floor when there are more
	/// than the widget was sent.
	public var waitingLabel: String {
		"\(waiting.count)\(hasMore ? "+" : "") unacknowledged"
	}

	/// The snapshot after an acknowledgement the widget just made, so the row
	/// changes before the next read confirms it.
	public func replacing(_ page: Page) -> PagesSnapshot {
		var next = self
		next.pages = pages.map { $0.id == page.id ? page : $0 }
		// Keep the unanswered first, as the server orders them.
		next.pages = next.pages.filter(\.awaitsAcknowledgement) + next.pages.filter { !$0.awaitsAcknowledgement }
		return next
	}
}

extension PagesSnapshot {
	/// The widget gallery and the redacted placeholder.
	public static var sample: PagesSnapshot {
		PagesSnapshot(
			generatedAt: Date(),
			organizationId: "org_sample",
			organizationName: "acme-prod",
			hasMore: false,
			pages: [
				Page(
					id: "inc_YofPTrK9782DWwcnXhpcCw",
					ruleName: "Checkout error rate",
					group: "checkout-api",
					isCritical: true,
					value: "9.1%",
					threshold: "> 5%",
					openedAt: Date().addingTimeInterval(-161),
					nextPageAt: Date().addingTimeInterval(228),
					nextPagePeople: "Priya Shah"
				)
			]
		)
	}
}

extension WidgetSnapshotStore where Value == PagesSnapshot {
	/// Per organization, never per environment: a page is a person's, whatever
	/// environment the rule watches.
	public static func pages(
		organizationId: String,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) -> WidgetSnapshotStore<PagesSnapshot> {
		.init(key: "pages.snapshot.v1.\(organizationId)", appGroupIdentifier: appGroupIdentifier)
	}
}

/// The Pages widget's two requests, signed with the device credential the app
/// registered. The app uses it too, to publish the same snapshot the widget
/// would have fetched.
///
/// Like the summary fetcher, failing changes nothing: the widget keeps its last
/// snapshot and says how old it is.
public actor WidgetPagesClient {
	public static let shared = WidgetPagesClient()

	private let credentials: WidgetCredentialStore
	private let keys: any DeviceKeyStoring
	private let tokens: DeviceTokenClient
	private let session: any WidgetHTTPTransport
	/// Where snapshots are written. Only tests point it elsewhere.
	private let appGroupIdentifier: String

	public init(
		credentials: WidgetCredentialStore = WidgetCredentialStore(),
		keys: any DeviceKeyStoring = KeychainDeviceKeyStore(),
		tokens: DeviceTokenClient? = nil,
		session: (any WidgetHTTPTransport)? = nil,
		appGroupIdentifier: String = WidgetAppGroup.identifier
	) {
		self.credentials = credentials
		self.keys = keys
		self.appGroupIdentifier = appGroupIdentifier
		let session = session ?? WidgetSummaryFetcher.makeSession()
		self.session = session
		self.tokens = tokens ?? DeviceTokenClient(transport: session, store: credentials)
	}

	public enum Refresh: Sendable, Equatable {
		case fetched(PagesSnapshot)
		/// The app has not registered a key for this organization yet.
		case noCredential
		/// The credential expired or was refused. Only the app can replace it.
		case needsApp
		case failed
	}

	public enum Acknowledgement: Sendable, Equatable {
		case acknowledged(PagesSnapshot.Page)
		/// The incident resolved, or no longer exists: there is no page left.
		case nothingToAnswer
		/// This credential cannot acknowledge. The app registers one that can.
		case needsApp
		case failed
	}

	/// Whether the widget may offer its button for this organization.
	public nonisolated func canAcknowledge(organizationId: String, now: Date = Date()) -> Bool {
		guard let device = credentials.loadDevice(organizationId: organizationId) else { return false }
		return device.canAcknowledgePages && !device.isExpired(at: now)
	}

	/// Read what is paging the person this credential belongs to, and store it.
	public func refresh(organizationId: String, organizationName: String?, now: Date = Date()) async -> Refresh {
		guard let (device, key) = signer(organizationId: organizationId, now: now) else {
			return credentials.loadDevice(organizationId: organizationId) == nil ? .noCredential : .needsApp
		}
		let url = device.apiBaseURL.appendingPathComponent("v2/widget_summary/pages")
		let sent = await DeviceRequest.send(
			{ Self.request(url, method: "GET") },
			credential: device, key: key, session: session, tokens: tokens, now: now
		)
		guard case .response(let response) = sent else { return .failed }
		switch response.status {
		case 200:
			// The organization the credential is bound to is the one the server
			// answers for; a disagreement would put one organization's pages
			// under another's name.
			guard let payload = try? WidgetJSON.decoder.decode(WidgetPagesPayload.self, from: response.data),
				payload.organizationId == organizationId
			else { return .failed }
			let snapshot = payload.snapshot(organizationName: organizationName)
			store(organizationId).save(snapshot)
			return .fetched(snapshot)
		case 401, 403:
			return .needsApp
		default:
			return .failed
		}
	}

	/// Acknowledge one incident, and write the answer into the stored snapshot.
	public func acknowledge(organizationId: String, incidentId: String, now: Date = Date()) async -> Acknowledgement {
		guard let (device, key) = signer(organizationId: organizationId, now: now), device.canAcknowledgePages else {
			return .needsApp
		}
		let url = device.apiBaseURL
			.appendingPathComponent("v2/widget_summary/pages")
			.appendingPathComponent(incidentId)
			.appendingPathComponent("acknowledge")
		let sent = await DeviceRequest.send(
			{ Self.request(url, method: "POST") },
			credential: device, key: key, session: session, tokens: tokens, now: now
		)
		guard case .response(let response) = sent else { return .failed }
		switch response.status {
		case 200:
			guard let page = try? WidgetJSON.decoder.decode(WidgetPagesPayload.Page.self, from: response.data).page
			else { return .failed }
			let store = store(organizationId)
			if let stored = store.load() { store.save(stored.replacing(page)) }
			return .acknowledged(page)
		case 404, 409:
			return .nothingToAnswer
		case 401, 403:
			return .needsApp
		default:
			return .failed
		}
	}

	/// The registered credential and the key it is bound to, when both are
	/// usable. A record without its key (a restored backup) signs nothing.
	private func signer(organizationId: String, now: Date) -> (DeviceCredential, DeviceKey)? {
		guard let device = credentials.loadDevice(organizationId: organizationId), !device.isExpired(at: now),
			let key = keys.load(organizationId: organizationId), key.thumbprint == device.jkt
		else { return nil }
		return (device, key)
	}

	private nonisolated func store(_ organizationId: String) -> WidgetSnapshotStore<PagesSnapshot> {
		.pages(organizationId: organizationId, appGroupIdentifier: appGroupIdentifier)
	}

	private static func request(_ url: URL, method: String) -> URLRequest {
		var request = URLRequest(url: url, timeoutInterval: WidgetSummaryFetcher.deadline)
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		return request
	}
}
