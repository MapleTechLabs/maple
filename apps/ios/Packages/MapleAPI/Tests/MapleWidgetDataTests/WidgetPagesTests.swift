import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let organizationId = "org_pages"
private let apiBase = URL(string: "https://api.maple.test")!
private let listPath = "/v2/widget_summary/pages"
private let incidentId = "inc_tC4d9V79DCDzgbGKhAnff9"
private let acknowledgePath = "/v2/widget_summary/pages/\(incidentId)/acknowledge"

/// Answers from a script and keeps every request it was sent.
private actor ScriptedTransport: WidgetHTTPTransport {
	struct Reply: Sendable {
		var status: Int
		var body: String
	}

	private var replies: [String: Reply]
	private(set) var requests: [URLRequest] = []

	init(_ replies: [String: Reply]) {
		self.replies = replies
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		requests.append(request)
		guard let url = request.url, let reply = replies[url.path],
			let response = HTTPURLResponse(
				url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
				headerFields: ["Content-Type": "application/json"]
			)
		else { throw URLError(.notConnectedToInternet) }
		return (Data(reply.body.utf8), response)
	}

	func requests(to path: String) -> [URLRequest] { requests.filter { $0.url?.path == path } }
}

private final class MemoryKeyStore: DeviceKeyStoring, @unchecked Sendable {
	private let lock = NSLock()
	private var keys: [String: DeviceKey] = [:]

	func load(organizationId: String) -> DeviceKey? { lock.withLock { keys[organizationId] } }

	func generate(organizationId: String) throws -> DeviceKey {
		DeviceKey(organizationId: organizationId, isHardwareBacked: false, signer: SoftwareDeviceKey())
	}

	func save(_ key: DeviceKey) throws { lock.withLock { keys[key.organizationId] = key } }
	func delete(organizationId: String) { _ = lock.withLock { keys.removeValue(forKey: organizationId) } }
	func deleteAll() { lock.withLock { keys.removeAll() } }
}

private let tokenReply = ScriptedTransport.Reply(
	status: 200,
	body: #"{"object":"device_token","access_token":"t1","token_type":"DPoP","expires_in":3600,"scope":"widget_summary:read widget_summary:write"}"#
)

private func pageJSON(acknowledgedBy: String? = nil, byYou: Bool = false, rule: String = "Checkout error rate", id: String = incidentId)
	-> String
{
	"""
	{"incident_id":"\(id)","rule_name":"\(rule)","group":"checkout-api","severity":"critical",
	 "value":"9.1%","threshold":"> 5%","opened_at":"2027-01-15T07:57:19.000Z",
	 "acknowledged_by":\(acknowledgedBy.map { "\"\($0)\"" } ?? "null"),"acknowledged_by_you":\(byYou),
	 "next_page_at":\(acknowledgedBy == nil ? "\"2027-01-15T08:03:48.000Z\"" : "null"),
	 "next_page_people":\(acknowledgedBy == nil ? "\"Priya Shah\"" : "null")}
	"""
}

private func listJSON(_ pages: [String], organization: String = organizationId, hasMore: Bool = false) -> String {
	"""
	{"object":"widget_pages","generated_at":"2027-01-15T08:00:00.000Z","organization_id":"\(organization)",
	 "has_more":\(hasMore),"data":[\(pages.joined(separator: ","))]}
	"""
}

private struct Harness {
	let suite = "widget-pages-tests-\(UUID().uuidString)"
	let directory: URL
	let credentials: WidgetCredentialStore
	let keys = MemoryKeyStore()

	init() {
		directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(suite, isDirectory: true)
		credentials = WidgetCredentialStore(directory: directory)
	}

	/// A registered key and its record, as the app leaves them.
	func register(scopes: [String]? = ["widget_summary:read", "widget_summary:write"]) throws {
		let key = try keys.generate(organizationId: organizationId)
		try keys.save(key)
		credentials.saveDevice(
			DeviceCredential(
				organizationId: organizationId,
				credentialId: "dcred_1",
				jkt: key.thumbprint,
				apiBaseURL: apiBase,
				attested: false,
				expiresAt: now.addingTimeInterval(30 * 86_400),
				hardExpiresAt: now.addingTimeInterval(90 * 86_400),
				registeredAt: now,
				scopes: scopes
			)
		)
	}

	func client(_ transport: ScriptedTransport) -> WidgetPagesClient {
		WidgetPagesClient(credentials: credentials, keys: keys, session: transport, appGroupIdentifier: suite)
	}

	/// What the app reads before deciding the registered key is still good.
	var isCredentialRejected: Bool {
		WidgetFetchStateStore(appGroupIdentifier: suite).load(organizationId: organizationId).isCredentialRejected
	}

	var lastTap: PagesTapRecord.Outcome? {
		WidgetSnapshotStore<PagesTapRecord>.pagesTap(organizationId: organizationId, appGroupIdentifier: suite).load()?.outcome
	}

	var lastRead: PagesReadRecord? {
		WidgetSnapshotStore<PagesReadRecord>.pagesRead(organizationId: organizationId, appGroupIdentifier: suite).load()
	}

	var stored: PagesSnapshot? {
		WidgetSnapshotStore<PagesSnapshot>.pages(organizationId: organizationId, appGroupIdentifier: suite).load()
	}

	func cleanUp() {
		try? FileManager.default.removeItem(at: directory)
		UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
	}
}

@Suite("Pages widget snapshot")
struct PagesSnapshotTests {
	private func snapshot(_ pages: [String], hasMore: Bool = false) throws -> PagesSnapshot {
		try WidgetJSON.decoder
			.decode(WidgetPagesPayload.self, from: Data(listJSON(pages, hasMore: hasMore).utf8))
			.snapshot(organizationName: "acme-prod")
	}

	@Test("Decodes what the server sends into rows the widget draws")
	func decodes() throws {
		let snapshot = try snapshot([pageJSON(), pageJSON(acknowledgedBy: "Dana Kim", id: "inc_other")])
		#expect(snapshot.organizationId == organizationId)
		#expect(snapshot.waitingLabel == "1 unacknowledged")
		let page = try #require(snapshot.waiting.first)
		#expect(page.id == incidentId)
		#expect(page.isCritical)
		#expect([page.value, page.threshold, page.group] == ["9.1%", "> 5%", "checkout-api"])
		#expect(page.nextPagePeople == "Priya Shah")
		#expect(snapshot.pages[1].acknowledgedLine == "Acknowledged by Dana Kim")
	}

	@Test("A count the server cut short reads as a floor")
	func floor() throws {
		#expect(try snapshot([pageJSON()], hasMore: true).waitingLabel == "1+ unacknowledged")
	}

	@Test("The next page is shown only while it is still ahead")
	func upcoming() throws {
		let page = try #require(try snapshot([pageJSON()]).pages.first)
		let at = try #require(page.nextPageAt)
		#expect(page.upcomingPage(at: at.addingTimeInterval(-60)) == at)
		#expect(page.upcomingPage(at: at.addingTimeInterval(1)) == nil)
		// An answered page is waiting on nothing, whatever time it carries.
		var answered = page
		answered.acknowledgedBy = "you"
		#expect(answered.upcomingPage(at: at.addingTimeInterval(-60)) == nil)
	}

	@Test("An acknowledgement made on the widget moves its row behind what still waits")
	func replacing() throws {
		let snapshot = try snapshot([pageJSON(), pageJSON(rule: "Queue depth", id: "inc_queue")])
		var answered = snapshot.pages[0]
		answered.acknowledgedBy = "Me"
		answered.acknowledgedByYou = true
		let next = snapshot.replacing(answered)
		#expect(next.pages.map(\.id) == ["inc_queue", incidentId])
		#expect(next.waiting.map(\.ruleName) == ["Queue depth"])
		#expect(next.pages[1].acknowledgedLine == "Acknowledged by you")
	}

	@Test("A credential says whether it may acknowledge, and one saved before scopes were kept may not")
	func credentialScopes() throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		#expect(harness.credentials.loadDevice(organizationId: organizationId)?.canAcknowledgePages == true)
		try harness.register(scopes: ["widget_summary:read"])
		#expect(harness.credentials.loadDevice(organizationId: organizationId)?.canAcknowledgePages == false)

		let legacy = #"{"organizationId":"org_old","credentialId":"dcred_0","jkt":"x","apiBaseURL":"https://api.maple.test","attested":false,"expiresAt":"2027-02-01T00:00:00.000Z","hardExpiresAt":"2027-04-01T00:00:00.000Z","registeredAt":"2027-01-01T00:00:00.000Z"}"#
		let decoded = try WidgetJSON.decoder.decode(DeviceCredential.self, from: Data(legacy.utf8))
		#expect(decoded.scopes == nil)
		#expect(!decoded.canAcknowledgePages)
	}
}

@Suite("Pages widget client", .serialized)
struct WidgetPagesClientTests {
	@Test("Reads what is paging you with the device credential, and stores it")
	func refresh() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = ScriptedTransport([
			"/v2/device_tokens": tokenReply,
			listPath: .init(status: 200, body: listJSON([pageJSON()])),
		])

		let outcome = await harness.client(transport).refresh(organizationId: organizationId, organizationName: "acme-prod", now: now)
		guard case .fetched(let snapshot) = outcome else {
			Issue.record("expected a snapshot, got \(outcome)")
			return
		}
		#expect(snapshot.organizationName == "acme-prod")
		#expect(harness.stored == snapshot)
		let request = try #require(await transport.requests(to: listPath).first)
		#expect(request.httpMethod == "GET")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP t1")
		#expect(request.value(forHTTPHeaderField: "DPoP") != nil)
	}

	@Test("Stores nothing for another organization's answer, a refusal, or no credential")
	func refreshFailures() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let none = await harness.client(ScriptedTransport([:])).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(none == .noCredential)

		try harness.register()
		let wrongOrganization = ScriptedTransport([
			"/v2/device_tokens": tokenReply,
			listPath: .init(status: 200, body: listJSON([pageJSON()], organization: "org_other")),
		])
		#expect(await harness.client(wrongOrganization).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		let refused = ScriptedTransport(["/v2/device_tokens": tokenReply, listPath: .init(status: 403, body: "{}")])
		#expect(await harness.client(refused).refresh(organizationId: organizationId, organizationName: nil, now: now) == .needsApp)
		#expect(harness.stored == nil)
		// Every read leaves how it ended, and a run of failures is counted until one lands.
		#expect(harness.lastRead?.outcome == .needsApp)
		#expect(harness.lastRead?.consecutiveFailures == 3)
		let working = ScriptedTransport(["/v2/device_tokens": tokenReply, listPath: .init(status: 200, body: listJSON([pageJSON()]))])
		_ = await harness.client(working).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(harness.lastRead == PagesReadRecord(outcome: .fetched, at: now, consecutiveFailures: 0))
	}

	@Test("A revoked credential is recorded for the app to replace, and a refusal of the request or no network is not")
	func revokedCredential() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		// The key is fine, the request is not allowed: nothing a new key would fix.
		let forbidden = ScriptedTransport(["/v2/device_tokens": tokenReply, listPath: .init(status: 403, body: "{}")])
		_ = await harness.client(forbidden).refresh(organizationId: organizationId, organizationName: nil, now: now)
		#expect(await harness.client(ScriptedTransport([:])).refresh(organizationId: organizationId, organizationName: nil, now: now) == .failed)
		#expect(!harness.isCredentialRejected)

		// A role change revoked the key: the token in hand is refused, and the
		// token endpoint no longer knows the key that would buy another.
		let revoked = ScriptedTransport([
			listPath: .init(status: 401, body: #"{"error":{"code":"invalid_token"}}"#),
			"/v2/device_tokens": .init(status: 401, body: #"{"error":{"code":"invalid_device_credential"}}"#),
		])
		#expect(await harness.client(revoked).refresh(organizationId: organizationId, organizationName: nil, now: now) == .needsApp)
		#expect(harness.isCredentialRejected)

		// Until the app replaces the key nothing is sent with it, and no button is offered.
		let silent = ScriptedTransport(["/v2/device_tokens": tokenReply, listPath: .init(status: 200, body: listJSON([pageJSON()]))])
		let client = harness.client(silent)
		#expect(await client.refresh(organizationId: organizationId, organizationName: nil, now: now) == .needsApp)
		#expect(await client.acknowledge(organizationId: organizationId, incidentId: incidentId, now: now) == .needsApp)
		#expect(!client.canAcknowledge(organizationId: organizationId, now: now))
		#expect(await silent.requests.isEmpty)
	}

	@Test("Acknowledges with a signed POST and writes the answer into the stored snapshot")
	func acknowledge() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = ScriptedTransport([
			"/v2/device_tokens": tokenReply,
			listPath: .init(status: 200, body: listJSON([pageJSON()])),
			acknowledgePath: .init(status: 200, body: pageJSON(acknowledgedBy: "Me Myself", byYou: true)),
		])
		let client = harness.client(transport)
		_ = await client.refresh(organizationId: organizationId, organizationName: nil, now: now)

		let outcome = await client.acknowledge(organizationId: organizationId, incidentId: incidentId, now: now)
		guard case .acknowledged(let page) = outcome else {
			Issue.record("expected an acknowledgement, got \(outcome)")
			return
		}
		#expect(page.acknowledgedByYou)
		#expect(harness.stored?.waiting.isEmpty == true)
		#expect(harness.stored?.pages.first?.acknowledgedLine == "Acknowledged by you")
		let request = try #require(await transport.requests(to: acknowledgePath).first)
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP t1")
	}

	@Test("Does not send an acknowledgement its credential would be refused, and tells a resolved incident from a failure")
	func acknowledgeOutcomes() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register(scopes: ["widget_summary:read"])
		let unsent = ScriptedTransport(["/v2/device_tokens": tokenReply])
		#expect(await harness.client(unsent).acknowledge(organizationId: organizationId, incidentId: incidentId, now: now) == .needsApp)
		#expect(await unsent.requests.isEmpty)
		#expect(!harness.client(unsent).canAcknowledge(organizationId: organizationId, now: now))

		try harness.register()
		#expect(harness.client(unsent).canAcknowledge(organizationId: organizationId, now: now))
		func outcome(_ status: Int) async -> WidgetPagesClient.Acknowledgement {
			let transport = ScriptedTransport(["/v2/device_tokens": tokenReply, acknowledgePath: .init(status: status, body: "{}")])
			return await harness.client(transport).acknowledge(organizationId: organizationId, incidentId: incidentId, now: now)
		}
		#expect(await outcome(409) == .nothingToAnswer)
		#expect(await outcome(404) == .nothingToAnswer)
		#expect(await outcome(403) == .needsApp)
		// Each tap leaves what it came to for the app to report.
		#expect(harness.lastTap == .needsApp)
		#expect(await outcome(500) == .failed)
		#expect(harness.lastTap == .failed)
	}
}
