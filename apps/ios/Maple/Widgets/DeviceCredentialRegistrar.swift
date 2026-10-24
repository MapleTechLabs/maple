import DeviceCheck
import Foundation
import MapleAPI
import MapleWidgetData

/// Registers, refreshes and rotates the widget extension's device-bound key.
///
/// One P-256 key per organization, made here and usable by the extension
/// through the shared widget keychain group. The server sees only its public
/// half; the extension signs DPoP proofs with it to get short-lived tokens.
struct DeviceCredentialRegistrar {
	let credentials: WidgetCredentialStore
	let keys: any DeviceKeyStoring
	let attestor = AppAttestor()

	enum Action: String {
		/// The organization's first key.
		case register
		/// The same key again, extending the rolling expiry.
		case refresh
		/// A new key: the old one is near its hard cap, lost, or refused.
		case rotate
	}

	enum Outcome {
		case registered(DeviceCredential, action: Action, key: DeviceKey)
		/// The API predates device credentials (404): use the legacy key.
		case unsupportedServer
	}

	/// Nothing to do: a live registration for the key the keychain holds.
	func isCurrent(organizationId: String, now: Date) -> Bool {
		guard let stored = credentials.loadDevice(organizationId: organizationId),
			let key = keys.load(organizationId: organizationId)
		else { return false }
		return key.thumbprint == stored.jkt && !stored.needsRefresh(at: now) && !stored.needsRotation(at: now)
	}

	func ensure(
		organizationId: String,
		api: any MapleAPI,
		installationId: String,
		now: Date = Date()
	) async throws -> Outcome {
		let stored = credentials.loadDevice(organizationId: organizationId)
		var key = keys.load(organizationId: organizationId)
		var action: Action
		var isNewKey = false
		if let existing = key,
			stored == nil || (stored?.jkt == existing.thumbprint && stored?.needsRotation(at: now) == false)
		{
			// A key with no record is one whose registration never finished:
			// offer it again rather than orphan it.
			action = stored == nil ? .register : .refresh
		} else {
			key = try keys.create(organizationId: organizationId)
			isNewKey = true
			action = stored == nil ? .register : .rotate
		}
		guard var signer = key else { throw DeviceKeyStoreError.invalidOrganizationId }

		var record: DeviceCredential
		do {
			record = try await register(signer, attest: isNewKey || stored == nil, api: api, installationId: installationId)
		} catch let error as MapleAPIError where error.status == 404 {
			return .unsupportedServer
		} catch let error as MapleAPIError where error.code == "device_key_in_use" || error.code == "device_key_invalid" {
			// A retired key can never come back, and the server keeps one key per
			// organization: the only way forward is a new one.
			signer = try keys.create(organizationId: organizationId)
			isNewKey = true
			action = .rotate
			record = try await register(signer, attest: true, api: api, installationId: installationId)
		}
		guard record.organizationId == organizationId, record.jkt == signer.thumbprint else {
			throw DeviceCredentialMismatch()
		}
		guard credentials.saveDevice(record) else { throw DeviceCredentialNotStored() }
		// A token bound to the previous key is worthless now.
		if isNewKey { credentials.clearToken(organizationId: organizationId) }
		return .registered(record, action: action, key: signer)
	}

	/// One PUT, attested when the key is new and App Attest is available.
	///
	/// An attestation the server refuses (a development build against a server
	/// that only takes production) falls back to an unattested registration.
	private func register(
		_ key: DeviceKey,
		attest: Bool,
		api: any MapleAPI,
		installationId: String
	) async throws -> DeviceCredential {
		let attestation = attest ? try? await attestor.attest(key: key, api: api, installationId: installationId) : nil
		do {
			return try await api.registerDeviceCredential(installationId: installationId, key: key, attestation: attestation)
		} catch let error as MapleAPIError where error.code == "device_attestation_invalid" && attestation != nil {
			return try await api.registerDeviceCredential(installationId: installationId, key: key, attestation: nil)
		}
	}
}

struct DeviceCredentialMismatch: Error {}
struct DeviceCredentialNotStored: Error {}

/// App Attest for a freshly made signing key.
///
/// A new App Attest key per signing key, not per launch: an attest key can be
/// attested once (the server checks counter 0), and a signing key is new only
/// on first registration or rotation, so in practice this is once per org.
struct AppAttestor {
	var isSupported: Bool { DCAppAttestService.shared.isSupported }

	func attest(key: DeviceKey, api: any MapleAPI, installationId: String) async throws -> DeviceAttestationPayload? {
		let service = DCAppAttestService.shared
		// False on the simulator and on devices without the Secure Enclave.
		guard service.isSupported else { return nil }
		let challenge = try await api.deviceAttestationChallenge(installationId: installationId)
		let keyId = try await service.generateKey()
		let object = try await service.attestKey(
			keyId,
			clientDataHash: DeviceAttestationBinding.clientDataHash(challenge: challenge, jkt: key.thumbprint)
		)
		return DeviceAttestationPayload(
			keyId: keyId,
			attestationObject: object.base64EncodedString(),
			challenge: challenge
		)
	}
}
