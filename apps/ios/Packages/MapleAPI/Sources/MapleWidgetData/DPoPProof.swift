import CryptoKit
import Foundation

/// RFC 9449 proofs: a compact JWS, `typ` `dpop+jwt`, ES256, the public key inline.
public enum DPoPProof {
	struct Header: Codable, Equatable {
		let typ: String
		let alg: String
		let jwk: DevicePublicJWK
	}

	struct Claims: Codable, Equatable {
		let jti: String
		let htm: String
		let htu: String
		let iat: Int
		let ath: String?
	}

	/// Scheme, host, port and path; query and fragment dropped (RFC 9449 section 4.2).
	public static func htu(for url: URL) -> String? {
		guard var components = URLComponents(url: url, resolvingAgainstBaseURL: true),
			components.scheme != nil, components.host != nil
		else { return nil }
		components.query = nil
		components.fragment = nil
		components.user = nil
		components.password = nil
		components.scheme = components.scheme?.lowercased()
		components.host = components.host?.lowercased()
		if (components.scheme == "https" && components.port == 443) || (components.scheme == "http" && components.port == 80) {
			components.port = nil
		}
		if components.path.isEmpty { components.path = "/" }
		return components.string
	}

	/// `ath`: base64url SHA-256 of the access token's ASCII.
	public static func accessTokenHash(_ accessToken: String) -> String {
		Base64URL.encode(Data(SHA256.hash(data: Data(accessToken.utf8))))
	}

	/// A fresh 128-bit random `jti`, 22 characters.
	public static func makeJTI() -> String {
		var generator = SystemRandomNumberGenerator()
		let bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
		return Base64URL.encode(bytes)
	}

	public enum ProofError: Error, Sendable {
		case invalidURL
	}

	/// Sign a proof for one request.
	/// - Parameter accessToken: set for resource requests, which carry `ath`.
	public static func make(
		key: any DeviceSigningKey,
		method: String,
		url: URL,
		accessToken: String? = nil,
		issuedAt: Date,
		jti: String = makeJTI()
	) throws -> String {
		guard let htu = htu(for: url) else { throw ProofError.invalidURL }
		let header = Header(typ: "dpop+jwt", alg: "ES256", jwk: key.publicJWK)
		let claims = Claims(
			jti: jti,
			htm: method.uppercased(),
			htu: htu,
			iat: Int(issuedAt.timeIntervalSince1970.rounded(.down)),
			ath: accessToken.map(accessTokenHash)
		)
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
		let signingInput = Base64URL.encode(try encoder.encode(header)) + "." + Base64URL.encode(try encoder.encode(claims))
		let signature = try key.sign(Data(signingInput.utf8))
		return signingInput + "." + Base64URL.encode(signature)
	}
}
