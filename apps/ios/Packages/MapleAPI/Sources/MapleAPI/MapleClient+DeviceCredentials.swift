import Foundation
import MapleWidgetData
import OpenAPIRuntime

/// An App Attest attestation for one registration, as the server takes it.
public struct DeviceAttestationPayload: Sendable, Hashable {
	/// `generateKey`'s key id, base64.
	public var keyId: String
	/// `attestKey`'s object, base64.
	public var attestationObject: String
	/// The challenge it was made for, unchanged.
	public var challenge: String

	public init(keyId: String, attestationObject: String, challenge: String) {
		self.keyId = keyId
		self.attestationObject = attestationObject
		self.challenge = challenge
	}
}

/// Device-bound widget credentials (RFC 9449): the app registers a public key,
/// the widget extension trades proofs signed by it for short-lived tokens.
extension MapleClient {
	public func deviceAttestationChallenge(installationId: String) async throws -> String {
		try await mapping {
			let output = try await client.getDeviceAttestationChallenge(
				.init(path: .init(installationId: installationId))
			)
			return try output.ok.body.json.challenge
		}
	}

	/// Register `key`, or refresh it when the server already has it.
	///
	/// The request carries a `DPoP` proof signed by the key being registered, so
	/// the server knows the caller holds it, alongside the Clerk session.
	public func registerDeviceCredential(
		installationId: String,
		key: DeviceKey,
		attestation: DeviceAttestationPayload?
	) async throws -> DeviceCredential {
		let jwk = key.publicJWK
		return try await mapping {
			let url = serverURL.appendingPathComponent("v2/device_credentials").appendingPathComponent(installationId)
			let proof = try DPoPProof.make(key: key.signer, method: "PUT", url: url, issuedAt: Date())
			let output = try await client.registerDeviceCredential(
				.init(
					path: .init(installationId: installationId),
					headers: .init(dpop: proof),
					body: .json(
						.init(
							attestation: attestation.map {
								.init(attestationObject: $0.attestationObject, challenge: $0.challenge, keyId: $0.keyId)
							},
							publicJwk: .init(crv: .p256, kty: .ec, x: jwk.x, y: jwk.y)
						)
					)
				)
			)
			let credential = try output.ok.body.json
			guard
				let expiresAt = ResolvedTimeWindow.parse(credential.expiresAt),
				let hardExpiresAt = ResolvedTimeWindow.parse(credential.hardExpiresAt)
			else {
				throw MapleAPIError.decoding(WidgetSummaryDecodingError.unreadableCredentialDates)
			}
			return DeviceCredential(
				organizationId: credential.organizationId,
				credentialId: credential.id,
				jkt: credential.jkt,
				// The host this client talks to, for the same reason as the legacy
				// credential: a key registered locally means nothing to production.
				apiBaseURL: serverURL,
				attested: credential.attested,
				expiresAt: expiresAt,
				hardExpiresAt: hardExpiresAt,
				registeredAt: Date()
			)
		}
	}

	/// Sign-out, leaving an organization, or a key the app is discarding.
	public func revokeDeviceCredential(installationId: String) async throws {
		try await mapping {
			_ = try await client.revokeDeviceCredential(
				.init(path: .init(installationId: installationId))
			).ok
		}
	}
}

extension MapleAPIError {
	/// The envelope's stable `code`, when the server sent one.
	public var code: String? { body?.code }

	/// The status of an API or non-envelope failure.
	public var status: Int? {
		switch self {
		case .api(let status, _), .unexpectedStatus(let status, _): status
		default: nil
		}
	}
}
