import CryptoKit
import Foundation
import HTTPTypes
import MapleWidgetData
import OpenAPIRuntime
import Testing

@testable import MapleAPI

private final class RecordingTransport: ClientTransport, @unchecked Sendable {
	private(set) var request: HTTPRequest?
	private(set) var body: [String: Any]?
	private let status: HTTPResponse.Status
	private let responseJSON: String

	init(status: HTTPResponse.Status = .ok, responseJSON: String) {
		self.status = status
		self.responseJSON = responseJSON
	}

	func send(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		self.request = request
		if let body {
			let data = Data(try await [UInt8](collecting: body, upTo: 1_000_000))
			self.body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
		}
		var response = HTTPResponse(status: status)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(responseJSON))
	}
}

private struct StaticTokens: MapleTokenProvider {
	func token(forceRefresh: Bool) async throws -> String? { "session-token" }
}

private func credentialJSON(jkt: String) -> String {
	"""
	{"object":"device_credential","id":"dcred_1","organization_id":"org_1","installation_id":"inst-1",
	 "jkt":"\(jkt)","scopes":["widget_summary:read"],"attested":false,
	 "created_at":"2026-10-24T09:10:00.000Z","expires_at":"2026-11-23T09:10:00.000Z",
	 "hard_expires_at":"2027-01-22T09:10:00.000Z"}
	"""
}

@Suite("Device credential registration")
struct DeviceCredentialRegistrationTests {
	private let server = URL(string: "https://api.maple.test")!

	@Test("PUT carries the session bearer, the JWK, and a DPoP proof signed by that key")
	func proofOnRegistration() async throws {
		let key = DeviceKey(organizationId: "org_1", isHardwareBacked: false, signer: SoftwareDeviceKey())
		let transport = RecordingTransport(responseJSON: credentialJSON(jkt: key.thumbprint))
		let client = MapleClient(tokens: StaticTokens(), serverURL: server, transport: transport)

		let record = try await client.registerDeviceCredential(installationId: "inst-1", key: key, attestation: nil)
		#expect(record.jkt == key.thumbprint)
		#expect(record.apiBaseURL == server)
		#expect(record.hardExpiresAt > record.expiresAt)

		let request = try #require(transport.request)
		#expect(request.method == .put)
		#expect(request.headerFields[.authorization] == "Bearer session-token")
		let jwk = try #require(transport.body?["public_jwk"] as? [String: String])
		#expect(jwk == ["kty": "EC", "crv": "P-256", "x": key.publicJWK.x, "y": key.publicJWK.y])
		#expect(transport.body?["attestation"] == nil)

		let proof = try #require(HTTPField.Name("DPoP").flatMap { request.headerFields[$0] })
		let parts = proof.split(separator: ".").map(String.init)
		#expect(parts.count == 3)
		let claims = try #require(
			Base64URL.decode(parts[1]).flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
		)
		#expect(claims["htm"] as? String == "PUT")
		#expect(claims["htu"] as? String == "https://api.maple.test/v2/device_credentials/inst-1")
		#expect(claims["ath"] == nil)
		let header = try #require(
			Base64URL.decode(parts[0]).flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
		)
		let headerJWK = try #require(header["jwk"] as? [String: String])
		#expect(DevicePublicJWK(x: headerJWK["x"] ?? "", y: headerJWK["y"] ?? "").thumbprint == key.thumbprint)
		let signature = try P256.Signing.ECDSASignature(rawRepresentation: try #require(Base64URL.decode(parts[2])))
		#expect(key.signer.publicKey.isValidSignature(signature, for: Data("\(parts[0]).\(parts[1])".utf8)))
	}

	@Test("sends an attestation as the server expects it")
	func attestationBody() async throws {
		let key = DeviceKey(organizationId: "org_1", isHardwareBacked: true, signer: SoftwareDeviceKey())
		let transport = RecordingTransport(responseJSON: credentialJSON(jkt: key.thumbprint))
		let client = MapleClient(tokens: StaticTokens(), serverURL: server, transport: transport)
		_ = try await client.registerDeviceCredential(
			installationId: "inst-1",
			key: key,
			attestation: DeviceAttestationPayload(keyId: "a2V5", attestationObject: "b2Jq", challenge: "chal")
		)
		let attestation = try #require(transport.body?["attestation"] as? [String: String])
		#expect(attestation == ["key_id": "a2V5", "attestation_object": "b2Jq", "challenge": "chal"])
	}

	@Test("surfaces a conflict as its code, and an older API as a 404")
	func errorCodes() async throws {
		let key = DeviceKey(organizationId: "org_1", isHardwareBacked: false, signer: SoftwareDeviceKey())
		let conflict = RecordingTransport(
			status: .conflict,
			responseJSON: #"{"error":{"_tag":"T","type":"invalid_request_error","code":"device_key_in_use","title":"t","message":"m","retryable":false,"recovery":"fix_request"}}"#
		)
		await #expect {
			try await MapleClient(tokens: StaticTokens(), serverURL: server, transport: conflict)
				.registerDeviceCredential(installationId: "inst-1", key: key, attestation: nil)
		} throws: { error in
			(error as? MapleAPIError)?.code == "device_key_in_use" && (error as? MapleAPIError)?.status == 409
		}
		let missing = RecordingTransport(status: .notFound, responseJSON: "")
		await #expect {
			try await MapleClient(tokens: StaticTokens(), serverURL: server, transport: missing)
				.registerDeviceCredential(installationId: "inst-1", key: key, attestation: nil)
		} throws: { error in
			(error as? MapleAPIError)?.status == 404
		}
	}

	@Test("tells an installation held by another member apart from a refused key")
	func classifiesConflicts() async throws {
		let key = DeviceKey(organizationId: "org_1", isHardwareBacked: false, signer: SoftwareDeviceKey())
		func failure(status: HTTPResponse.Status, code: String) async -> DeviceRegistrationFailure? {
			let transport = RecordingTransport(
				status: status,
				responseJSON: #"{"error":{"_tag":"T","type":"invalid_request_error","code":"\#(code)","title":"t","message":"m","retryable":false,"recovery":"fix_request"}}"#
			)
			do {
				_ = try await MapleClient(tokens: StaticTokens(), serverURL: server, transport: transport)
					.registerDeviceCredential(installationId: "inst-1", key: key, attestation: nil)
				return nil
			} catch {
				return (error as? MapleAPIError)?.deviceRegistrationFailure
			}
		}
		// Same status, opposite remedies: a new key fixes the first and cannot fix the second.
		#expect(await failure(status: .conflict, code: "device_key_in_use") == .keyRejected)
		#expect(await failure(status: .conflict, code: "device_installation_in_use") == .installationInUse)
		#expect(await failure(status: .badRequest, code: "device_key_invalid") == .keyRejected)
		#expect(await failure(status: .badRequest, code: "device_attestation_invalid") == .attestationRejected)
		#expect(await failure(status: .badRequest, code: "invalid_dpop_proof") == .other)
		#expect(await failure(status: .notFound, code: "route_not_found") == .unsupportedServer)
	}
}
