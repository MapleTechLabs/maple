import Foundation

/// The one network call shape the extension needs, so tests can stub it.
public protocol WidgetHTTPTransport: Sendable {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: WidgetHTTPTransport {
	public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let (data, response) = try await data(for: request)
		guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
		return (data, http)
	}
}

/// What a v2 failure said, read from the envelope and `WWW-Authenticate`.
public struct DeviceAuthError: Sendable, Equatable {
	public let status: Int
	/// The envelope's `code`, e.g. `invalid_device_credential`.
	public let code: String?
	/// `error=` from a `WWW-Authenticate: DPoP` challenge.
	public let challenge: String?

	public init(status: Int, code: String?, challenge: String?) {
		self.status = status
		self.code = code
		self.challenge = challenge
	}

	public init(status: Int, data: Data, headers: [AnyHashable: Any]) {
		struct Envelope: Decodable {
			struct Body: Decodable { let code: String? }
			let error: Body
		}
		let header = headers.first { ($0.key as? String)?.lowercased() == "www-authenticate" }?.value as? String
		self.init(
			status: status,
			code: (try? JSONDecoder().decode(Envelope.self, from: data))?.error.code,
			challenge: header.flatMap(Self.challengeError)
		)
	}

	/// `DPoP algs="ES256", error="invalid_token"` -> `invalid_token`.
	static func challengeError(_ header: String) -> String? {
		guard let range = header.range(of: #"error="([^"]*)""#, options: .regularExpression) else { return nil }
		return String(header[range].dropFirst(7).dropLast())
	}

	/// The token is no good, but the key may be: get another token.
	public var isInvalidToken: Bool { challenge == "invalid_token" || code == "invalid_credentials" }
	/// The proof itself was refused (clock, `htu`, replay).
	public var isInvalidProof: Bool { challenge == "invalid_dpop_proof" || code == "invalid_dpop_proof" }
	/// The key is unknown, revoked or expired: only the app can re-register.
	public var isInvalidDeviceCredential: Bool { code == "invalid_device_credential" }
}

/// Why no token could be had.
public enum DeviceTokenFailure: Error, Sendable, Equatable {
	/// `invalid_device_credential`, or the key is gone: the app must register again.
	case needsApp
	case unreachable
	/// 5xx, 429, a refused proof, or a body this build cannot read.
	case server
}

/// Fetches and caches DPoP access tokens, in memory and in the App Group.
///
/// Shared per process so the widgets woken together reuse one token. The
/// cache holds the token and its expiry only; the key never leaves the keychain.
public actor DeviceTokenClient {
	public static let shared = DeviceTokenClient()

	private let transport: any WidgetHTTPTransport
	private let store: WidgetCredentialStore
	private var memory: [String: DeviceAccessToken] = [:]
	/// Server clock minus ours, from the last `Date` header, applied to `iat`.
	private(set) var clockOffset: TimeInterval = 0

	public init(
		transport: any WidgetHTTPTransport = WidgetSummaryFetcher.makeSession(),
		store: WidgetCredentialStore = WidgetCredentialStore()
	) {
		self.transport = transport
		self.store = store
	}

	/// When a proof made now should say it was made.
	public func issuedAt(_ now: Date = Date()) -> Date {
		now.addingTimeInterval(abs(clockOffset) > 5 ? clockOffset : 0)
	}

	/// Remember the server's clock from any response that states it.
	public func observe(_ response: HTTPURLResponse, at now: Date = Date()) {
		guard let value = response.value(forHTTPHeaderField: "Date"), let date = Self.httpDate(value) else { return }
		clockOffset = date.timeIntervalSince(now)
	}

	/// A usable token for this credential, cached unless `forceRefresh`.
	public func token(
		for credential: DeviceCredential,
		key: DeviceKey,
		forceRefresh: Bool = false,
		now: Date = Date()
	) async -> Result<DeviceAccessToken, DeviceTokenFailure> {
		let organizationId = credential.organizationId
		if forceRefresh {
			invalidate(organizationId: organizationId)
		} else if let cached = memory[organizationId] ?? store.loadToken(organizationId: organizationId),
			cached.jkt == credential.jkt, cached.isUsable(at: now)
		{
			memory[organizationId] = cached
			return .success(cached)
		}

		// One retry for a refused proof: a skewed clock is corrected by the
		// rejection's own `Date` header.
		for attempt in 0..<2 {
			switch await requestToken(credential: credential, key: key, now: now) {
			case .success(let token):
				memory[organizationId] = token
				store.saveToken(token)
				return .success(token)
			case .failure(.proofRejected) where attempt == 0:
				continue
			case .failure(.proofRejected):
				return .failure(.server)
			case .failure(.other(let failure)):
				return .failure(failure)
			}
		}
		return .failure(.server)
	}

	public func invalidate(organizationId: String) {
		memory[organizationId] = nil
		store.clearToken(organizationId: organizationId)
	}

	private enum RequestFailure: Error {
		case proofRejected
		case other(DeviceTokenFailure)
	}

	private struct TokenResponse: Decodable {
		let access_token: String
		let token_type: String
		let expires_in: Int
	}

	private func requestToken(
		credential: DeviceCredential,
		key: DeviceKey,
		now: Date
	) async -> Result<DeviceAccessToken, RequestFailure> {
		let url = credential.apiBaseURL.appendingPathComponent("v2/device_tokens")
		let proof: String
		do {
			proof = try DPoPProof.make(key: key.signer, method: "POST", url: url, issuedAt: issuedAt(now))
		} catch {
			// A key the enclave will not sign with is as gone as a deleted one.
			return .failure(.other(.needsApp))
		}
		var request = URLRequest(url: url, timeoutInterval: WidgetSummaryFetcher.deadline)
		request.httpMethod = "POST"
		request.setValue(proof, forHTTPHeaderField: "DPoP")
		request.setValue("application/json", forHTTPHeaderField: "Accept")

		let data: Data
		let response: HTTPURLResponse
		do {
			(data, response) = try await transport.send(request)
		} catch {
			return .failure(.other(.unreachable))
		}
		observe(response, at: now)
		switch response.statusCode {
		case 200:
			guard let body = try? JSONDecoder().decode(TokenResponse.self, from: data),
				body.token_type.caseInsensitiveCompare("DPoP") == .orderedSame
			else { return .failure(.other(.server)) }
			return .success(
				DeviceAccessToken(
					organizationId: credential.organizationId,
					jkt: credential.jkt,
					accessToken: body.access_token,
					expiresAt: now.addingTimeInterval(TimeInterval(body.expires_in))
				)
			)
		default:
			let error = DeviceAuthError(status: response.statusCode, data: data, headers: response.allHeaderFields)
			if error.isInvalidDeviceCredential || response.statusCode == 401 || response.statusCode == 403 {
				return .failure(.other(.needsApp))
			}
			if error.isInvalidProof { return .failure(.proofRejected) }
			return .failure(.other(.server))
		}
	}

	private static func httpDate(_ value: String) -> Date? {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(identifier: "GMT")
		formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
		return formatter.date(from: value)
	}
}
