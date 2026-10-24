import CryptoKit
import Foundation

/// Unpadded base64url (RFC 4648 section 5), the encoding every JOSE member uses.
public enum Base64URL {
	public static func encode<D: DataProtocol>(_ data: D) -> String {
		Data(data).base64EncodedString()
			.replacingOccurrences(of: "+", with: "-")
			.replacingOccurrences(of: "/", with: "_")
			.replacingOccurrences(of: "=", with: "")
	}

	public static func decode(_ text: String) -> Data? {
		var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
		let remainder = base64.count % 4
		if remainder == 1 { return nil }
		if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
		return Data(base64Encoded: base64)
	}
}

/// The public half of a device key as an RFC 7517 JWK: EC P-256, nothing else.
///
/// Exactly the four members the server accepts. Anything more (a `kid`, a
/// `use`) is rejected there rather than stored, so it is never written here.
public struct DevicePublicJWK: Codable, Sendable, Hashable {
	public let kty: String
	public let crv: String
	public let x: String
	public let y: String

	public init(x: String, y: String) {
		self.kty = "EC"
		self.crv = "P-256"
		self.x = x
		self.y = y
	}

	/// From CryptoKit's X9.63 form, `0x04 || X || Y` with 32-byte coordinates.
	/// Fixed-width coordinates encode to canonical 43-character base64url.
	public init(publicKey: P256.Signing.PublicKey) {
		let point = publicKey.x963Representation
		self.init(
			x: Base64URL.encode(point.dropFirst().prefix(32)),
			y: Base64URL.encode(point.dropFirst(33))
		)
	}

	/// RFC 7638 section 3.2: the required members, lexicographic, no whitespace.
	public var thumbprintInput: String {
		#"{"crv":"\#(crv)","kty":"\#(kty)","x":"\#(x)","y":"\#(y)"}"#
	}

	/// The key's identity on the server (`jkt`, and `cnf.jkt` in its tokens).
	public var thumbprint: String { Self.thumbprint(canonicalJSON: thumbprintInput) }

	/// RFC 7638 section 3.1 step 3: base64url SHA-256 of the canonical JSON.
	static func thumbprint(canonicalJSON: String) -> String {
		Base64URL.encode(Data(SHA256.hash(data: Data(canonicalJSON.utf8))))
	}
}

/// A P-256 key that can sign a DPoP proof.
public protocol DeviceSigningKey: Sendable {
	var publicKey: P256.Signing.PublicKey { get }
	/// ES256 over `data`, as JWS wants it: raw `r || s`, 64 bytes, not DER.
	func sign(_ data: Data) throws -> Data
}

extension DeviceSigningKey {
	public var publicJWK: DevicePublicJWK { DevicePublicJWK(publicKey: publicKey) }
}

/// The software fallback, used where there is no Secure Enclave (the simulator).
public struct SoftwareDeviceKey: DeviceSigningKey {
	let privateKey: P256.Signing.PrivateKey

	public init(_ privateKey: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) {
		self.privateKey = privateKey
	}

	public var publicKey: P256.Signing.PublicKey { privateKey.publicKey }

	public func sign(_ data: Data) throws -> Data {
		try privateKey.signature(for: data).rawRepresentation
	}
}

/// A key generated in, and never leaving, the Secure Enclave.
///
/// `dataRepresentation` is an opaque blob only this device's enclave can use,
/// which is what the keychain stores: a copy of it is worthless anywhere else.
public struct SecureEnclaveDeviceKey: DeviceSigningKey {
	let privateKey: SecureEnclave.P256.Signing.PrivateKey

	public init(_ privateKey: SecureEnclave.P256.Signing.PrivateKey) {
		self.privateKey = privateKey
	}

	public var publicKey: P256.Signing.PublicKey { privateKey.publicKey }

	public func sign(_ data: Data) throws -> Data {
		try privateKey.signature(for: data).rawRepresentation
	}
}

/// One organization's widget key, with where it came from.
public struct DeviceKey: Sendable {
	public let organizationId: String
	/// True when the private key lives in the Secure Enclave.
	public let isHardwareBacked: Bool
	public let signer: any DeviceSigningKey

	public init(organizationId: String, isHardwareBacked: Bool, signer: any DeviceSigningKey) {
		self.organizationId = organizationId
		self.isHardwareBacked = isHardwareBacked
		self.signer = signer
	}

	public var publicJWK: DevicePublicJWK { signer.publicJWK }
	public var thumbprint: String { publicJWK.thumbprint }
}

/// The App Attest binding the server checks: `SHA256(UTF8("<challenge>.<jkt>"))`.
///
/// Ties one attestation to one server challenge and one signing key, so an
/// attestation cannot be replayed for a key it was not made for.
public enum DeviceAttestationBinding {
	public static func clientDataHash(challenge: String, jkt: String) -> Data {
		Data(SHA256.hash(data: Data("\(challenge).\(jkt)".utf8)))
	}
}
