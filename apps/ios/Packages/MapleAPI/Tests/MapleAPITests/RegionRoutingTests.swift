import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MapleAPI

/// Records the host each request was sent to.
private final class HostRecordingTransport: ClientTransport, @unchecked Sendable {
	private(set) var baseURLs: [URL] = []

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		baseURLs.append(baseURL)
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(#"{"object":"list","has_more":false,"next_cursor":null,"data":[]}"#))
	}
}

/// A Clerk-shaped session token whose payload names `claims`; the signature is never checked here.
private func sessionToken(_ claims: [String: Any]) -> String {
	let payload = try! JSONSerialization.data(withJSONObject: claims)
		.base64EncodedString()
		.replacingOccurrences(of: "+", with: "-")
		.replacingOccurrences(of: "/", with: "_")
		.replacingOccurrences(of: "=", with: "")
	return "eyJhbGciOiJSUzI1NiJ9.\(payload).signature"
}

private struct FixedToken: MapleTokenProvider {
	let value: String?
	func token(forceRefresh: Bool) async throws -> String? { value }
}

@Suite("Region routing")
struct RegionRoutingTests {
	private let us = URL(string: "https://api.maple.dev")!
	private let eu = URL(string: "https://api.eu.maple.dev")!
	private let regions = OrganizationRegions(["org_us": .us, "org_eu": .eu])

	private var window: ResolvedTimeWindow {
		TimeWindow.last24Hours.resolve(now: Date(timeIntervalSince1970: 1_756_000_000))
	}

	private func client(token: String?, transport: HostRecordingTransport) throws -> MapleClient {
		MapleClient(
			tokens: FixedToken(value: token),
			servers: try .production(),
			regions: regions,
			transport: transport
		)
	}

	@Test("An organization's home region is the first known entry of its regions, US without one")
	func homeRegion() {
		#expect(MapleRegion.home(ofRegions: ["eu"]) == .eu)
		#expect(MapleRegion.home(ofRegions: ["apac", nil, "eu", "us"]) == .eu)
		#expect(MapleRegion.home(ofRegions: ["EU"]) == .us)
		#expect(MapleRegion.home(ofRegions: []) == .us)
		#expect(MapleRegion.home(ofRegions: nil) == .us)
	}

	@Test("The OpenAPI document's servers are the US and EU API hosts")
	func productionServers() throws {
		let servers = try APIServers.production()
		#expect(servers.url(for: .us) == us)
		#expect(servers.url(for: .eu) == eu)
	}

	@Test("A request goes to the region of the organization in the session token")
	func activeOrganization() async throws {
		let transport = HostRecordingTransport()
		_ = try await client(token: sessionToken(["o": ["id": "org_eu"]]), transport: transport)
			.services(window: window, limit: 50)
		_ = try await client(token: sessionToken(["org_id": "org_us"]), transport: transport)
			.services(window: window, limit: 50)
		#expect(transport.baseURLs == [eu, us])
	}

	@Test("A client scoped to an organization uses that organization's region, not the active one")
	func scopedOrganization() async throws {
		let transport = HostRecordingTransport()
		let api = try client(token: sessionToken(["o": ["id": "org_us"]]), transport: transport)
		_ = try await api.scoped(to: "org_eu").services(window: window, limit: 50)
		#expect(transport.baseURLs == [eu])
		#expect(try await (api.scoped(to: "org_eu") as? MapleClient)?.serverURL() == eu)
		#expect(try await api.serverURL() == us)
	}

	@Test("A token without an organization goes to the default region, which answers it")
	func noOrganization() async throws {
		let transport = HostRecordingTransport()
		_ = try await client(token: sessionToken(["sub": "user_1"]), transport: transport).services(window: window, limit: 50)
		#expect(transport.baseURLs == [us])
	}

	@Test("An organization whose region the app never learned is not sent anywhere")
	func unknownOrganization() async throws {
		let transport = HostRecordingTransport()
		let api = try client(token: sessionToken(["o": ["id": "org_new"]]), transport: transport)
		await #expect {
			_ = try await api.services(window: window, limit: 50)
		} throws: { error in
			guard case .unknownRegion(let organizationId) = error as? MapleAPIError else { return false }
			return organizationId == "org_new"
		}
		#expect(transport.baseURLs.isEmpty)
	}

	@Test("A single configured host serves every organization, known or not")
	func singleHost() async throws {
		let local = URL(string: "http://localhost:3472")!
		let transport = HostRecordingTransport()
		let api = MapleClient(
			tokens: FixedToken(value: sessionToken(["o": ["id": "org_new"]])),
			servers: .single(local),
			regions: OrganizationRegions(),
			transport: transport
		)
		_ = try await api.services(window: window, limit: 50)
		#expect(transport.baseURLs == [local])
	}
}
