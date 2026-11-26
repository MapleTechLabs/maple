import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

/// An incident as the wire carries it, with the fields a case needs overridden.
private func incident(_ overrides: [String: Any] = [:]) throws -> AlertIncident {
	var json: [String: Any] = [
		"id": "inc_tC4d9V79DCDzgbGKhAnff9",
		"object": "alert_incident",
		"rule_id": "alrt_gU26thvJECdQvu54Ad9jiz",
		"rule_name": "Checkout error rate",
		"group_key": NSNull(),
		"signal_type": "error_rate",
		"severity": "critical",
		"peak_severity": "critical",
		"status": "open",
		"comparator": "gt",
		"threshold": 0.05,
		"threshold_upper": NSNull(),
		"first_triggered_at": "2026-11-27T01:12:00.000Z",
		"last_triggered_at": "2026-11-27T01:14:00.000Z",
		"resolved_at": NSNull(),
		"last_observed_value": 0.091,
		"last_sample_count": 132,
		"dedupe_key": "alrt_gU26thvJECdQvu54Ad9jiz:__total__",
		"last_delivered_event_type": "trigger",
		"last_notified_at": "2026-11-27T01:12:05.000Z",
		"hold_reason": NSNull(),
		"held_since": NSNull(),
		"acknowledged_at": NSNull(),
		"acknowledged_by": NSNull(),
		"acknowledged_via": NSNull(),
		"first_acknowledged_at": NSNull(),
		"error_issue_id": NSNull(),
		"escalation": NSNull(),
		"silence_id": NSNull(),
		"silenced_at": NSNull(),
	]
	json.merge(overrides) { _, new in new }
	return try JSONDecoder().decode(AlertIncident.self, from: JSONSerialization.data(withJSONObject: json))
}

private func escalation(_ overrides: [String: Any] = [:]) -> [String: Any] {
	var json: [String: Any] = [
		"chain_id": "esc_gQtGH2s65G6a7sJmuayXL6",
		"chain_name": "Platform primary",
		"status": "active",
		"step": 2,
		"step_count": 3,
		"pass": 1,
		"pass_count": 1,
		"steps_sent": 1,
		"next_step_at": "2026-11-27T01:19:00.000Z",
		"next_step_people": [["user_id": "user_priya", "name": "Priya Shah"]],
	]
	json.merge(overrides) { _, new in new }
	return json
}

private func event(_ overrides: [String: Any]) throws -> AlertIncidentEvent {
	var json: [String: Any] = [
		"id": "aie_2Nk8mXqPfR3yZ1aB4cD5eF",
		"object": "alert_incident_event",
		"incident_id": "inc_tC4d9V79DCDzgbGKhAnff9",
		"type": "acknowledged",
		"actor": NSNull(),
		"source": NSNull(),
		"created_at": "2026-11-27T01:14:00.000Z",
	]
	json.merge(overrides) { _, new in new }
	return try JSONDecoder().decode(AlertIncidentEvent.self, from: JSONSerialization.data(withJSONObject: json))
}

@Suite("Incident response state")
struct IncidentResponseStateTests {
	@Test("An open incident with a waiting escalation says who is paged next and when")
	func unacknowledgedWithNextPage() throws {
		let state = try incident(["escalation": escalation()]).responseState
		guard case .unacknowledged(let next?) = state else {
			Issue.record("expected a waiting page, got \(state)")
			return
		}
		#expect(next.headline(viewerUserId: nil) == "Pages Priya Shah")
		#expect(next.position == "Step 2 of 3")
		#expect(next.chainName == "Platform primary")
		let now = try #require(ResolvedTimeWindow.parse("2026-11-27T01:15:12.000Z"))
		#expect(next.countdown(now: now) == "3m 48s")
	}

	@Test("The next page names several people, the viewer as you, and a step with nobody by its number")
	func nextPageHeadlines() throws {
		let two = try incident([
			"escalation": escalation([
				"next_step_people": [
					["user_id": "user_me", "name": "Me"], ["user_id": "user_dana", "name": "Dana Kim"],
				]
			])
		]).responseState
		let many = try incident([
			"escalation": escalation([
				"pass": 2, "pass_count": 3,
				"next_step_people": [
					["user_id": "user_priya", "name": "Priya Shah"], ["user_id": "user_dana", "name": NSNull()],
					["user_id": "user_marco", "name": "Marco Ruiz"],
				],
			])
		]).responseState
		let nobody = try incident(["escalation": escalation(["next_step_people": []])]).responseState

		guard case .unacknowledged(let twoNext?) = two, case .unacknowledged(let manyNext?) = many,
			case .unacknowledged(let nobodyNext?) = nobody
		else {
			Issue.record("expected three waiting pages")
			return
		}
		#expect(twoNext.headline(viewerUserId: "user_me") == "Pages you and Dana Kim")
		#expect(manyNext.headline(viewerUserId: nil) == "Pages Priya Shah +2")
		#expect(manyNext.position == "Step 2 of 3, pass 2 of 3")
		#expect(nobodyNext.headline(viewerUserId: nil) == "Escalates to step 2 of 3")
	}

	@Test("The countdown never goes negative and widens its units")
	func countdown() throws {
		let state = try incident(["escalation": escalation()]).responseState
		guard case .unacknowledged(let next?) = state else {
			Issue.record("expected a waiting page")
			return
		}
		let at = next.at
		#expect(next.countdown(now: at.addingTimeInterval(-48)) == "48s")
		#expect(next.countdown(now: at) == "now")
		#expect(next.countdown(now: at.addingTimeInterval(30)) == "now")
		#expect(next.countdown(now: at.addingTimeInterval(-3_725)) == "1h 2m")
	}

	@Test("An escalation block from a server that predates the people field still says when the next page is")
	func nextPageWithoutPeople() throws {
		var block = escalation()
		block.removeValue(forKey: "next_step_people")
		let state = try incident(["escalation": block]).responseState
		guard case .unacknowledged(let next?) = state else {
			Issue.record("expected a waiting page, got \(state)")
			return
		}
		#expect(next.people.isEmpty)
		#expect(next.headline(viewerUserId: nil) == "Escalates to step 2 of 3")
	}

	@Test("No run, a paused run or an ended run leaves an open incident with no next page")
	func unacknowledgedWithoutNextPage() throws {
		#expect(try incident().responseState == .unacknowledged(nil))
		for status in ["acknowledged", "exhausted", "superseded", "resolved"] {
			let state = try incident([
				"escalation": escalation(["status": status, "next_step_at": NSNull(), "next_step_people": []])
			]).responseState
			#expect(state == .unacknowledged(nil))
		}
	}

	@Test("An acknowledged incident says who has it and how long it waited")
	func acknowledged() throws {
		let state = try incident([
			"acknowledged_at": "2026-11-27T01:14:00.000Z",
			"first_acknowledged_at": "2026-11-27T01:14:00.000Z",
			"acknowledged_by": ["user_id": "user_me", "name": "Me Myself"],
			"acknowledged_via": "mobile",
			// Still reads active until the scheduler pauses it; the acknowledgement wins.
			"escalation": escalation(),
		]).responseState
		guard case .acknowledged(let ack) = state else {
			Issue.record("expected an acknowledgement, got \(state)")
			return
		}
		#expect(ack.headline(viewerUserId: "user_me") == "Acknowledged by you")
		#expect(ack.headline(viewerUserId: "user_other") == "Acknowledged by Me Myself")
		#expect(ack.waitedText == "2m after it opened")
		#expect(ack.summary(viewerUserId: "user_me") == "Acknowledged by you, 2m after it opened")
		#expect(ack.source == .mobile)
	}

	@Test("A later acknowledgement does not claim the first one's speed")
	func laterAcknowledgement() throws {
		let state = try incident([
			"acknowledged_at": "2026-11-27T03:20:00.000Z",
			"first_acknowledged_at": "2026-11-27T01:14:00.000Z",
			"acknowledged_by": ["user_id": "user_dana", "name": "Dana Kim"],
			"acknowledged_via": "web",
		]).responseState
		guard case .acknowledged(let ack) = state else {
			Issue.record("expected an acknowledgement, got \(state)")
			return
		}
		#expect(ack.summary(viewerUserId: nil) == "Acknowledged by Dana Kim · first acknowledged after 2m")
	}

	@Test("An acknowledgement nobody is named on reads as an agent or a teammate")
	func unnamedAcknowledgement() throws {
		func headline(via: String) throws -> String {
			let state = try incident([
				"acknowledged_at": "2026-11-27T01:12:20.000Z",
				"first_acknowledged_at": "2026-11-27T01:12:20.000Z",
				"acknowledged_by": ["user_id": NSNull(), "name": NSNull()],
				"acknowledged_via": via,
			]).responseState
			guard case .acknowledged(let ack) = state else { return "" }
			return "\(ack.headline(viewerUserId: "user_me")), \(ack.waitedText ?? "")"
		}
		#expect(try headline(via: "mcp") == "Acknowledged by an agent over MCP, under 1m after it opened")
		#expect(try headline(via: "slack") == "Acknowledged by a teammate, under 1m after it opened")
	}

	@Test("A resolved incident is resolved whatever it was before, and keeps its time to acknowledge")
	func resolved() throws {
		let closed = try incident([
			"status": "resolved",
			"resolved_at": "2026-11-27T02:30:00.000Z",
			"first_acknowledged_at": "2026-11-27T02:17:00.000Z",
		])
		#expect(closed.responseState == .resolved)
		#expect(closed.timeToAcknowledge.map(IncidentWording.span) == "1h 5m")
		#expect(IncidentWording.span(49 * 3_600 + 300) == "2d 1h")
		#expect(try incident().timeToAcknowledge == nil)
	}
}

@Suite("Incident event wording")
struct IncidentEventWordingTests {
	@Test("Acknowledge, unacknowledge and resolve name who did it and where from")
	func activity() throws {
		let acked = try event([
			"actor": ["user_id": "user_me", "name": "Me Myself"], "source": "mobile",
		]).line(viewerUserId: "user_me")
		#expect(acked == .init(title: "Acknowledged by you", detail: "From the mobile app · reminders paused", tone: .info))

		let unacked = try event([
			"type": "unacknowledged", "actor": ["user_id": "user_dana", "name": "Dana Kim"], "source": "web",
		]).line(viewerUserId: "user_me")
		#expect(unacked.title == "Unacknowledged by Dana Kim")
		#expect(unacked.detail == "From the dashboard · reminders resume")

		let resolved = try event([
			"type": "resolved", "actor": ["user_id": NSNull(), "name": "deploy-bot"], "source": "api",
		]).line(viewerUserId: nil)
		#expect(resolved.title == "Resolved by deploy-bot")
		#expect(resolved.tone == .good)

		let cleared = try event(["type": "ack_cleared"]).line(viewerUserId: nil)
		#expect(cleared == .init(
			title: "Acknowledgement cleared", detail: "The incident escalated, so it notified again", tone: .warn
		))
	}

	@Test("A page says who, by which channel, and what became of it")
	func pages() throws {
		func page(_ status: String, channel: String = "push", userId: String = "user_me", error: Any = NSNull()) throws
			-> IncidentEventLine
		{
			try event([
				"type": "paged",
				"page": [
					"user_id": userId, "name": "Me Myself", "channel": channel, "status": status,
					"error_message": error,
				],
			]).line(viewerUserId: "user_me")
		}
		#expect(try page("sent") == .init(title: "Paged you by phone", detail: nil, tone: .info))
		#expect(try page("sent", channel: "slack", userId: "user_x").title == "Paged Me Myself by Slack DM")
		#expect(try page("sending", channel: "email", error: "timeout").detail == "Retrying: timeout")
		#expect(try page("skipped").detail == "Acknowledged or resolved first")
		let failed = try page("failed", error: "No phone is registered for this member")
		#expect(failed.title == "Couldn't page you by phone")
		#expect(failed.detail == "No phone is registered for this member")
		#expect(failed.tone == .critical)
		// A paged event that lost its page says only that someone was paged.
		#expect(try event(["type": "paged"]).line(viewerUserId: nil).title == "Paged a member")
	}

	@Test("An on-call gap names the schedule, or says the step reached nobody")
	func gaps() throws {
		let named = try event(["type": "on_call_gap", "detail": "Checkout primary"]).line(viewerUserId: nil)
		#expect(named.title == "Nobody on call on Checkout primary")
		let bare = try event(["type": "on_call_gap"]).line(viewerUserId: nil)
		#expect(bare.title == "An escalation step reached nobody")
		#expect(bare.tone == .warn)
	}

	@Test("Whether someone was paged reads from the page events, on any channel")
	func pagedLookup() throws {
		let events = [
			try event(["type": "acknowledged"]),
			try event([
				"type": "paged",
				"page": [
					"user_id": "user_me", "name": NSNull(), "channel": "email", "status": "sent",
					"error_message": NSNull(),
				],
			]),
		]
		#expect(events.paged(userId: "user_me"))
		#expect(!events.paged(userId: "user_other"))
		#expect(!events.paged(userId: nil))
		// A page that was skipped because someone acknowledged first paged nobody.
		let skipped = [
			try event([
				"type": "paged",
				"page": [
					"user_id": "user_me", "name": NSNull(), "channel": "push", "status": "skipped",
					"error_message": NSNull(),
				],
			])
		]
		#expect(!skipped.paged(userId: "user_me"))
	}
}

/// Records the request the generated client produced.
private final class CapturingTransport: ClientTransport, @unchecked Sendable {
	private(set) var requests: [HTTPRequest] = []
	private let responseJSON: String

	init(responseJSON: String) {
		self.responseJSON = responseJSON
	}

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		requests.append(request)
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(responseJSON))
	}
}

private struct FixedToken: MapleTokenProvider {
	func token(forceRefresh: Bool) async throws -> String? { "test-token" }
}

@Suite("Answering a page over the wire")
struct IncidentResponseWireTests {
	private func client(_ transport: CapturingTransport) -> MapleClient {
		MapleClient(tokens: FixedToken(), serverURL: URL(string: "https://api.maple.test")!, transport: transport)
	}

	@Test("Acknowledge posts to the incident and says it came from the iOS app")
	func acknowledge() async throws {
		let body = String(
			decoding: try JSONEncoder().encode(
				try incident([
					"acknowledged_at": "2026-11-27T01:14:00.000Z",
					"acknowledged_by": ["user_id": "user_me", "name": "Me"],
					"acknowledged_via": "mobile",
				])
			),
			as: UTF8.self
		)
		let transport = CapturingTransport(responseJSON: body)
		let acknowledged = try await client(transport).acknowledgeIncident(id: "inc_tC4d9V79DCDzgbGKhAnff9")

		let request = try #require(transport.requests.first)
		#expect(request.method == .post)
		#expect(request.path == "/v2/alerts/incidents/inc_tC4d9V79DCDzgbGKhAnff9/acknowledge")
		#expect(request.headerFields[ClientIdentityMiddleware.headerName] == "ios")
		#expect(acknowledged.acknowledgedVia == .mobile)
	}

	@Test("Unacknowledge, resolve and the event list each go to their own path")
	func otherCalls() async throws {
		let body = String(decoding: try JSONEncoder().encode(try incident()), as: UTF8.self)
		let transport = CapturingTransport(responseJSON: body)
		let api = client(transport)
		_ = try await api.unacknowledgeIncident(id: "inc_a")
		_ = try await api.resolveIncident(id: "inc_a")
		#expect(transport.requests.map(\.path) == [
			"/v2/alerts/incidents/inc_a/unacknowledge", "/v2/alerts/incidents/inc_a/resolve",
		])
		#expect(transport.requests.allSatisfy { $0.method == .post })

		let events = CapturingTransport(responseJSON: #"{"object":"list","data":[]}"#)
		#expect(try await client(events).alertIncidentEvents(incidentId: "inc_a").isEmpty)
		#expect(events.requests.first?.path == "/v2/alerts/incidents/inc_a/events")
		#expect(events.requests.first?.method == .get)
	}

	@Test("What is paging me asks for open incidents that paged the caller")
	func pagingMe() async throws {
		let transport = CapturingTransport(responseJSON: #"{"object":"list","data":[],"has_more":false,"next_cursor":null}"#)
		let incidents = try await client(transport).alertIncidentsPagingMe(limit: 50)

		#expect(incidents.isEmpty)
		let path = try #require(transport.requests.first?.path)
		#expect(path.hasPrefix("/v2/alerts/incidents?"))
		#expect(path.contains("status=open"))
		#expect(path.contains("paged=me"))
	}
}
