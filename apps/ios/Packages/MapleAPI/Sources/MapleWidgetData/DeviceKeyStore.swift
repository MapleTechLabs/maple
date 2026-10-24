import CryptoKit
import Foundation
import Security

/// Where widget keys live, behind a protocol so `swift test` can use memory.
public protocol DeviceKeyStoring: Sendable {
	func load(organizationId: String) -> DeviceKey?
	/// A fresh key for the organization, replacing any it had.
	func create(organizationId: String) throws -> DeviceKey
	func delete(organizationId: String)
	func deleteAll()
}

public enum DeviceKeyStoreError: Error, Sendable, Equatable {
	/// The bundle names no widget keychain group, so nothing is written rather
	/// than falling back to the default group, which is Clerk's.
	case missingAccessGroup
	case invalidOrganizationId
	case keychain(OSStatus)
}

/// The keychain store, in a group shared by the app and the widget extension.
///
/// A group of its own, deliberately not Clerk's: the extension may read widget
/// keys and must never read the session. Items are
/// `AfterFirstUnlockThisDeviceOnly` so a Lock Screen widget can sign while the
/// phone is locked, and are never synchronized or restored to another device.
public struct KeychainDeviceKeyStore: DeviceKeyStoring {
	/// The Info.plist key both targets carry, expanded from
	/// `$(AppIdentifierPrefix)com.maple.mobile.widget-keys`.
	public static let accessGroupInfoKey = "MapleWidgetKeychainGroup"
	static let service = "com.maple.mobile.widget-key"

	private enum Kind: UInt8 {
		case secureEnclave = 1
		case software = 2
	}

	private let accessGroup: String?
	private let prefersSecureEnclave: Bool

	public init(
		accessGroup: String? = Bundle.main.object(forInfoDictionaryKey: Self.accessGroupInfoKey) as? String,
		prefersSecureEnclave: Bool = SecureEnclave.isAvailable
	) {
		// An unexpanded or empty build setting is as good as missing.
		self.accessGroup = accessGroup.flatMap { $0.isEmpty || $0.contains("$(") ? nil : $0 }
		self.prefersSecureEnclave = prefersSecureEnclave
	}

	public func load(organizationId: String) -> DeviceKey? {
		guard var query = baseQuery(organizationId: organizationId) else { return nil }
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne
		var result: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
			let data = result as? Data,
			let first = data.first,
			let kind = Kind(rawValue: first)
		else { return nil }
		let blob = data.dropFirst()
		switch kind {
		case .secureEnclave:
			guard let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: Data(blob)) else {
				return nil
			}
			return DeviceKey(organizationId: organizationId, isHardwareBacked: true, signer: SecureEnclaveDeviceKey(key))
		case .software:
			guard let key = try? P256.Signing.PrivateKey(rawRepresentation: blob) else { return nil }
			return DeviceKey(organizationId: organizationId, isHardwareBacked: false, signer: SoftwareDeviceKey(key))
		}
	}

	public func create(organizationId: String) throws -> DeviceKey {
		guard accessGroup != nil else { throw DeviceKeyStoreError.missingAccessGroup }
		guard var query = baseQuery(organizationId: organizationId) else {
			throw DeviceKeyStoreError.invalidOrganizationId
		}
		let (kind, blob, key) = try generate(organizationId: organizationId)
		SecItemDelete(query as CFDictionary)
		query[kSecValueData as String] = Data([kind.rawValue]) + blob
		query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else { throw DeviceKeyStoreError.keychain(status) }
		return key
	}

	private func generate(organizationId: String) throws -> (Kind, Data, DeviceKey) {
		if prefersSecureEnclave,
			let access = SecAccessControlCreateWithFlags(
				nil,
				kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
				.privateKeyUsage,
				nil
			),
			let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
		{
			return (
				.secureEnclave,
				key.dataRepresentation,
				DeviceKey(organizationId: organizationId, isHardwareBacked: true, signer: SecureEnclaveDeviceKey(key))
			)
		}
		let key = P256.Signing.PrivateKey()
		return (
			.software,
			key.rawRepresentation,
			DeviceKey(organizationId: organizationId, isHardwareBacked: false, signer: SoftwareDeviceKey(key))
		)
	}

	public func delete(organizationId: String) {
		guard let query = baseQuery(organizationId: organizationId) else { return }
		SecItemDelete(query as CFDictionary)
	}

	public func deleteAll() {
		guard let accessGroup else { return }
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: Self.service,
			kSecAttrAccessGroup as String: accessGroup,
		]
		SecItemDelete(query as CFDictionary)
	}

	private func baseQuery(organizationId: String) -> [String: Any]? {
		guard let accessGroup, WidgetCredentialStore.isSafeOrganizationId(organizationId) else { return nil }
		return [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: Self.service,
			kSecAttrAccount as String: organizationId,
			kSecAttrAccessGroup as String: accessGroup,
			kSecAttrSynchronizable as String: false,
			kSecUseDataProtectionKeychain as String: true,
		]
	}
}
