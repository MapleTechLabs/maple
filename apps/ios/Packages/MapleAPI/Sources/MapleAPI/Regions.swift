import Foundation
import HTTPTypes
import OpenAPIRuntime
import Synchronization

/// The regional Maple instance an organization's data lives on. Each region is a
/// separate deployment with its own API host; nothing crosses between them.
/// Mirrors `MapleRegion` in `packages/domain/src/organization-regions.ts`.
public enum MapleRegion: String, Sendable, Hashable, CaseIterable {
	case us
	case eu

	public static let `default`: MapleRegion = .us

	/// The organization's home region from the `regions` list in its Clerk public
	/// metadata: the first known entry, and `us` when there is none, like
	/// `organizationHomeRegion` on the server. Nil means the key is absent or not a list.
	public static func home(ofRegions regions: [String?]?) -> MapleRegion {
		regions?.lazy.compactMap { $0.flatMap(MapleRegion.init(rawValue:)) }.first ?? .default
	}
}

/// The API host serving each region.
public struct APIServers: Sendable, Hashable {
	private let urls: [MapleRegion: URL]

	private init(urls: [MapleRegion: URL]) {
		self.urls = urls
	}

	/// The production instances, as the servers of the OpenAPI document declare them.
	public static func production() throws -> APIServers {
		APIServers(urls: [.us: try Servers.Server1.url(), .eu: try Servers.Server2.url()])
	}

	/// One host for every region: a locally run API or a preview, which are single instances.
	public static func single(_ url: URL) -> APIServers {
		APIServers(urls: Dictionary(uniqueKeysWithValues: MapleRegion.allCases.map { ($0, url) }))
	}

	public func url(for region: MapleRegion) -> URL {
		// Both constructors cover every case.
		urls[region]!
	}

	/// The host for a request on behalf of `organizationId`. No organization goes to the
	/// default region, which answers it as any instance would; one whose region the app
	/// never learned is refused rather than guessed.
	func url(for organizationId: String?, in regions: OrganizationRegions) throws -> URL {
		let distinct = Set(urls.values)
		if distinct.count == 1, let only = distinct.first { return only }
		guard let organizationId else { return url(for: .default) }
		guard let region = regions.region(of: organizationId) else {
			throw MapleAPIError.unknownRegion(organizationId: organizationId)
		}
		return url(for: region)
	}

	/// Every distinct host, for trace propagation.
	public var hosts: [String] {
		Array(Set(urls.values.compactMap(\.host))).sorted()
	}
}

/// Which region each of the user's organizations lives in, as the app last learned
/// from Clerk. Filled from the membership list; read on every request.
public final class OrganizationRegions: Sendable {
	private let regions = Mutex<[String: MapleRegion]>([:])

	public init(_ initial: [String: MapleRegion] = [:]) {
		regions.withLock { $0 = initial }
	}

	public func record(_ region: MapleRegion, for organizationId: String) {
		regions.withLock { $0[organizationId] = region }
	}

	public func record(_ entries: [String: MapleRegion]) {
		regions.withLock { $0.merge(entries) { _, new in new } }
	}

	public func region(of organizationId: String) -> MapleRegion? {
		regions.withLock { $0[organizationId] }
	}

	public func removeAll() {
		regions.withLock { $0.removeAll() }
	}
}

/// The organization a Clerk session token is for: `o.id` in v2 tokens, `org_id`
/// in v1. Read only to route the request; the server verifies the token.
enum SessionTokenClaims {
	static func organizationId(inBearer header: String) -> String? {
		guard header.hasPrefix("Bearer ") else { return nil }
		return organizationId(in: String(header.dropFirst("Bearer ".count)))
	}

	static func organizationId(in token: String) -> String? {
		let segments = token.split(separator: ".")
		guard segments.count == 3 else { return nil }
		var payload = segments[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
		payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
		guard
			let data = Data(base64Encoded: payload),
			let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return nil }
		if let organization = claims["o"] as? [String: Any], let id = organization["id"] as? String { return id }
		return claims["org_id"] as? String
	}
}

/// Sends each request to the API host of the organization it is for: the one
/// `OrganizationMiddleware` names, else the session token's active organization.
/// Runs after both, so it reads the finished request.
struct RegionRoutingMiddleware: ClientMiddleware {
	let servers: APIServers
	let regions: OrganizationRegions

	func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		let organizationId =
			request.headerFields[OrganizationMiddleware.headerName]
			?? request.headerFields[.authorization].flatMap(SessionTokenClaims.organizationId(inBearer:))
		return try await next(request, body, try servers.url(for: organizationId, in: regions))
	}
}
