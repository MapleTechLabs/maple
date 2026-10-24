import CryptoKit
import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let organizationId = "org_dpop"
private let apiBase = URL(string: "https://api.maple.test")!

// MARK: - Fixtures

/// Answers from a script and keeps every request it was sent.
private actor ScriptedTransport: WidgetHTTPTransport {
	struct Reply: Sendable {
		var status: Int
		var body: String
		var headers: [String: String] = [:]
	}

	private var replies: [String: [Reply]]
	private(set) var requests: [URLRequest] = []

	init(_ replies: [String: [Reply]]) {
		self.replies = replies
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		requests.append(request)
		let path = request.url?.path ?? ""
		guard var queue = replies[path], !queue.isEmpty else { throw URLError(.notConnectedToInternet) }
		let reply = queue.removeFirst()
		// The last reply repeats, so a test only scripts what changes.
		replies[path] = queue.isEmpty ? [reply] : queue
		var headers = reply.headers
		headers["Content-Type"] = "application/json"
		guard let url = request.url,
			let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)
		else { throw URLError(.badServerResponse) }
		return (Data(reply.body.utf8), response)
	}

	func requests(to path: String) -> [URLRequest] { requests.filter { $0.url?.path == path } }
}

private final class MemoryKeyStore: DeviceKeyStoring, @unchecked Sendable {
	private let lock = NSLock()
	private var keys: [String: DeviceKey] = [:]

	func load(organizationId: String) -> DeviceKey? { lock.withLock { keys[organizationId] } }

	func generate(organizationId: String) throws -> DeviceKey {
		DeviceKey(organizationId: organizationId, isHardwareBacked: false, signer: SoftwareDeviceKey())
	}

	func save(_ key: DeviceKey) throws { lock.withLock { keys[key.organizationId] = key } }

	func delete(organizationId: String) { _ = lock.withLock { keys.removeValue(forKey: organizationId) } }
	func deleteAll() { lock.withLock { keys.removeAll() } }
}

private func tokenReply(_ token: String, expiresIn: Int = 3600) -> ScriptedTransport.Reply {
	.init(
		status: 200,
		body: #"{"object":"device_token","access_token":"\#(token)","token_type":"DPoP","expires_in":\#(expiresIn),"scope":"widget_summary:read"}"#
	)
}

private func errorReply(_ status: Int, code: String, challenge: String? = nil, date: String? = nil) -> ScriptedTransport.Reply {
	var headers: [String: String] = [:]
	if let challenge { headers["WWW-Authenticate"] = #"DPoP algs="ES256", error="\#(challenge)""# }
	if let date { headers["Date"] = date }
	return .init(
		status: status,
		body: #"{"error":{"_tag":"T","type":"authentication_error","code":"\#(code)","title":"t","message":"m","retryable":false,"recovery":"none"}}"#,
		headers: headers
	)
}

private let summaryReply = summary(environment: nil)

private func summary(environment: String?) -> ScriptedTransport.Reply {
	.init(
	status: 200,
	body: """
	{"object":"widget_summary","schema_version":1,"generated_at":"2027-01-15T08:00:00.000Z",
	 "organization_id":"\(organizationId)",\(environment.map { #""deployment_environment":"\#($0)","# } ?? "")
	 "issues":{"window_seconds":86400,"has_more":false,"data":[]},
	 "throughput":{"window_seconds":3600,"bucket_seconds":60,"services":[],"total_points":[1]}}
	"""
	)
}

private struct Harness {
	let suite = "device-credential-tests-\(UUID().uuidString)"
	let directory: URL
	let credentials: WidgetCredentialStore
	let fetchStates: WidgetFetchStateStore
	let keys = MemoryKeyStore()

	init() {
		directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(suite, isDirectory: true)
		credentials = WidgetCredentialStore(directory: directory)
		fetchStates = WidgetFetchStateStore(appGroupIdentifier: suite)
	}

	/// A registered key and its record, as the app leaves them.
	@discardableResult
	func register() throws -> (DeviceCredential, DeviceKey) {
		let key = try keys.generate(organizationId: organizationId)
		try keys.save(key)
		let record = DeviceCredential(
			organizationId: organizationId,
			credentialId: "dcred_1",
			jkt: key.thumbprint,
			apiBaseURL: apiBase,
			attested: false,
			expiresAt: now.addingTimeInterval(30 * 86_400),
			hardExpiresAt: now.addingTimeInterval(90 * 86_400),
			registeredAt: now
		)
		credentials.saveDevice(record)
		return (record, key)
	}

	func tokenClient(_ transport: ScriptedTransport) -> DeviceTokenClient {
		DeviceTokenClient(transport: transport, store: credentials)
	}

	func fetcher(_ transport: ScriptedTransport) -> WidgetSummaryFetcher {
		WidgetSummaryFetcher(credentials: credentials, fetchStates: fetchStates, keys: keys, session: transport)
	}

	func cleanUp() {
		try? FileManager.default.removeItem(at: directory)
		UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
	}
}

/// The proof's three segments, decoded.
private struct DecodedProof {
	let header: [String: Any]
	let claims: [String: Any]
	let signingInput: String
	let signature: Data

	init?(_ compact: String) {
		let parts = compact.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
		guard parts.count == 3,
			let header = Base64URL.decode(parts[0]).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
			let claims = Base64URL.decode(parts[1]).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
			let signature = Base64URL.decode(parts[2])
		else { return nil }
		self.header = header
		self.claims = claims
		self.signingInput = parts[0] + "." + parts[1]
		self.signature = signature
	}

	func verifies(with key: P256.Signing.PublicKey) -> Bool {
		guard let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
		return key.isValidSignature(signature, for: Data(signingInput.utf8))
	}
}

// MARK: - JOSE

@Suite("JWK thumbprint")
struct JWKThumbprintTests {
	@Test("hashes canonical JSON as RFC 7638 section 3.1 does")
	func rfc7638Vector() {
		// The RFC's own RSA example, through the same hash-and-encode step.
		let n = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw"
		let canonical = #"{"e":"AQAB","kty":"RSA","n":"\#(n)"}"#
		#expect(DevicePublicJWK.thumbprint(canonicalJSON: canonical) == "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs")
	}

	@Test("orders EC members crv, kty, x, y and matches a known P-256 thumbprint")
	func ecVector() {
		// RFC 9449 section 6.1's key; the value was checked with Python's hashlib.
		let jwk = DevicePublicJWK(
			x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
			y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA"
		)
		#expect(
			jwk.thumbprintInput
				== #"{"crv":"P-256","kty":"EC","x":"l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs","y":"9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA"}"#
		)
		#expect(jwk.thumbprint == "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I")
	}

	@Test("encodes CryptoKit coordinates as canonical 43-character base64url that round-trips")
	func coordinatesRoundTrip() throws {
		for _ in 0..<20 {
			let key = P256.Signing.PrivateKey().publicKey
			let jwk = DevicePublicJWK(publicKey: key)
			#expect(jwk.x.count == 43 && jwk.y.count == 43)
			#expect(!jwk.x.contains("=") && !jwk.x.contains("+") && !jwk.x.contains("/"))
			let x = try #require(Base64URL.decode(jwk.x))
			let y = try #require(Base64URL.decode(jwk.y))
			#expect(Base64URL.encode(x) == jwk.x)
			let rebuilt = try P256.Signing.PublicKey(x963Representation: Data([0x04]) + x + y)
			#expect(rebuilt.rawRepresentation == key.rawRepresentation)
		}
	}
}

@Suite("DPoP proof")
struct DPoPProofTests {
	@Test("is an ES256 dpop+jwt whose raw r||s signature verifies against its own jwk")
	func structureAndSignature() throws {
		let key = SoftwareDeviceKey()
		let proof = try DPoPProof.make(
			key: key,
			method: "post",
			url: URL(string: "https://api.maple.test/v2/device_tokens")!,
			issuedAt: now,
			jti: "jti-0123456789"
		)
		let decoded = try #require(DecodedProof(proof))
		#expect(decoded.header["typ"] as? String == "dpop+jwt")
		#expect(decoded.header["alg"] as? String == "ES256")
		let jwk = try #require(decoded.header["jwk"] as? [String: String])
		#expect(jwk == ["kty": "EC", "crv": "P-256", "x": key.publicJWK.x, "y": key.publicJWK.y])
		#expect(decoded.claims["htm"] as? String == "POST")
		#expect(decoded.claims["htu"] as? String == "https://api.maple.test/v2/device_tokens")
		#expect(decoded.claims["iat"] as? Int == 1_800_000_000)
		#expect(decoded.claims["jti"] as? String == "jti-0123456789")
		#expect(decoded.claims["ath"] == nil)
		#expect(decoded.signature.count == 64)
		#expect(decoded.verifies(with: key.publicKey))
		#expect(!decoded.verifies(with: P256.Signing.PrivateKey().publicKey))
	}

	@Test("carries ath for a resource request, per RFC 9449's example")
	func ath() throws {
		#expect(
			DPoPProof.accessTokenHash("Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU")
				== "fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo"
		)
		let proof = try DPoPProof.make(
			key: SoftwareDeviceKey(),
			method: "GET",
			url: apiBase.appendingPathComponent("v2/widget_summary"),
			accessToken: "token-a",
			issuedAt: now
		)
		let decoded = try #require(DecodedProof(proof))
		#expect(decoded.claims["ath"] as? String == DPoPProof.accessTokenHash("token-a"))
	}

	@Test("normalizes htu: no query, no fragment, lowercase host, no default port")
	func htu() {
		let url = URL(string: "HTTPS://API.Maple.dev:443/v2/widget_summary?deployment_environment=prod#top")!
		#expect(DPoPProof.htu(for: url) == "https://api.maple.dev/v2/widget_summary")
		#expect(DPoPProof.htu(for: URL(string: "http://localhost:3472/v2/device_tokens")!) == "http://localhost:3472/v2/device_tokens")
	}

	@Test("never repeats a jti")
	func uniqueJTI() {
		let jtis = Set((0..<200).map { _ in DPoPProof.makeJTI() })
		#expect(jtis.count == 200)
		#expect(jtis.allSatisfy { (8...256).contains($0.count) })
	}

	@Test("binds App Attest to the challenge and the key: SHA256(challenge.jkt)")
	func clientDataHash() {
		let expected = Data(SHA256.hash(data: Data("abc.0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I".utf8)))
		#expect(DeviceAttestationBinding.clientDataHash(challenge: "abc", jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I") == expected)
	}
}

@Suite("DPoP error mapping")
struct DeviceAuthErrorTests {
	@Test("reads the WWW-Authenticate challenge and the envelope code")
	func parses() {
		let invalidToken = DeviceAuthError(
			status: 401,
			data: Data(),
			headers: ["Www-Authenticate": #"DPoP algs="ES256", error="invalid_token""#]
		)
		#expect(invalidToken.isInvalidToken)
		#expect(!invalidToken.isInvalidProof)

		let proof = DeviceAuthError(status: 401, data: Data(errorReply(401, code: "invalid_dpop_proof").body.utf8), headers: [:])
		#expect(proof.code == "invalid_dpop_proof")
		#expect(proof.isInvalidProof)

		let device = DeviceAuthError(status: 401, data: Data(errorReply(401, code: "invalid_device_credential").body.utf8), headers: [:])
		#expect(device.isInvalidDeviceCredential)
	}
}

// MARK: - Token client

@Suite("Device token client", .serialized)
struct DeviceTokenClientTests {
	@Test("caches a token in memory and in the App Group")
	func caches() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let (record, key) = try harness.register()
		let transport = ScriptedTransport(["/v2/device_tokens": [tokenReply("t1")]])

		let client = harness.tokenClient(transport)
		#expect(try await client.token(for: record, key: key, now: now).get().accessToken == "t1")
		#expect(try await client.token(for: record, key: key, now: now).get().accessToken == "t1")
		// A second process (the app, another provider) reads the App Group copy.
		let other = harness.tokenClient(transport)
		#expect(try await other.token(for: record, key: key, now: now).get().accessToken == "t1")
		#expect(await transport.requests(to: "/v2/device_tokens").count == 1)

		let stored = try #require(harness.credentials.loadToken(organizationId: organizationId))
		#expect(stored.jkt == record.jkt)
		#expect(stored.expiresAt == now.addingTimeInterval(3600))

		let proof = try #require(await transport.requests.first?.value(forHTTPHeaderField: "DPoP"))
		let decoded = try #require(DecodedProof(proof))
		#expect(decoded.claims["htm"] as? String == "POST")
		#expect(decoded.claims["htu"] as? String == "https://api.maple.test/v2/device_tokens")
		#expect(await transport.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
	}

	@Test("refetches near expiry, on demand, and for a different key")
	func refreshes() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let (record, key) = try harness.register()
		let transport = ScriptedTransport(["/v2/device_tokens": [tokenReply("t1"), tokenReply("t2"), tokenReply("t3"), tokenReply("t4")]])
		let client = harness.tokenClient(transport)

		_ = await client.token(for: record, key: key, now: now)
		// Inside the last minute: not worth sending.
		#expect(try await client.token(for: record, key: key, now: now.addingTimeInterval(3550)).get().accessToken == "t2")
		#expect(try await client.token(for: record, key: key, forceRefresh: true, now: now).get().accessToken == "t3")
		var rotated = record
		rotated.jkt = "another-key"
		#expect(try await client.token(for: rotated, key: key, now: now).get().accessToken == "t4")
	}

	@Test("maps token endpoint failures")
	func failures() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let (record, key) = try harness.register()
		let cases: [(ScriptedTransport.Reply, DeviceTokenFailure)] = [
			(errorReply(401, code: "invalid_device_credential"), .needsApp),
			(errorReply(503, code: "device_tokens_unavailable"), .server),
			(errorReply(429, code: "rate_limited"), .server),
			(.init(status: 200, body: "{}"), .server),
		]
		for (reply, expected) in cases {
			let transport = ScriptedTransport(["/v2/device_tokens": [reply]])
			let result = await harness.tokenClient(transport).token(for: record, key: key, now: now)
			#expect(result == .failure(expected))
		}
		let offline = ScriptedTransport([:])
		#expect(await harness.tokenClient(offline).token(for: record, key: key, now: now) == .failure(.unreachable))
	}

	@Test("retries a refused proof once, with iat moved to the server's clock")
	func clockSkew() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let (record, key) = try harness.register()
		// The server is 10 minutes ahead of this phone.
		let serverDate = "Fri, 15 Jan 2027 08:10:00 GMT"
		let transport = ScriptedTransport([
			"/v2/device_tokens": [errorReply(400, code: "invalid_dpop_proof", date: serverDate), tokenReply("t1")]
		])
		let serverTime = try #require(Self.httpDate(serverDate))
		let local = serverTime.addingTimeInterval(-600)
		let result = await harness.tokenClient(transport).token(for: record, key: key, now: local)
		#expect(try result.get().accessToken == "t1")

		let proofs = await transport.requests.compactMap { $0.value(forHTTPHeaderField: "DPoP") }.compactMap(DecodedProof.init)
		#expect(proofs.count == 2)
		#expect(proofs[0].claims["iat"] as? Int == Int(local.timeIntervalSince1970))
		#expect(proofs[1].claims["iat"] as? Int == Int(serverTime.timeIntervalSince1970))
		#expect(proofs[0].claims["jti"] as? String != proofs[1].claims["jti"] as? String)
	}

	private static func httpDate(_ text: String) -> Date? {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(identifier: "GMT")
		formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
		return formatter.date(from: text)
	}
}

// MARK: - Fetcher over DPoP

@Suite("Widget summary over DPoP", .serialized)
struct WidgetSummaryDPoPTests {
	@Test("sends Authorization DPoP with a proof bound to the token")
	func happyPath() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let (_, key) = try harness.register()
		let transport = ScriptedTransport([
			"/v2/device_tokens": [tokenReply("t1")],
			"/v2/widget_summary": [summary(environment: "prod")],
		])

		let attempt = await harness.fetcher(transport).fetch(
			organizationId: organizationId,
			organizationName: nil,
			environment: "prod",
			storedGeneratedAt: nil,
			now: now
		)
		guard case .fetched = attempt else {
			Issue.record("expected a fetch, got \(attempt)")
			return
		}
		let request = try #require(await transport.requests(to: "/v2/widget_summary").first)
		#expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP t1")
		let proof = try #require(request.value(forHTTPHeaderField: "DPoP").flatMap(DecodedProof.init))
		#expect(proof.claims["htm"] as? String == "GET")
		// The query is on the request, never in htu.
		#expect(request.url?.query == "deployment_environment=prod")
		#expect(proof.claims["htu"] as? String == "https://api.maple.test/v2/widget_summary")
		#expect(proof.claims["ath"] as? String == DPoPProof.accessTokenHash("t1"))
		#expect(proof.verifies(with: key.signer.publicKey))
		#expect(harness.fetchStates.load(organizationId: organizationId).lastAuthScheme == "dpop")
	}

	@Test("prefers the device credential over a legacy key")
	func prefersDevice() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		harness.credentials.save(
			WidgetCredential(
				organizationId: organizationId,
				secret: "maple_ak_legacy",
				apiBaseURL: apiBase,
				expiresAt: now.addingTimeInterval(86_400),
				mintedAt: now
			)
		)
		let transport = ScriptedTransport(["/v2/device_tokens": [tokenReply("t1")], "/v2/widget_summary": [summaryReply]])
		_ = await harness.fetcher(transport).fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		let headers = await transport.requests.compactMap { $0.value(forHTTPHeaderField: "Authorization") }
		#expect(!headers.contains { $0.contains("maple_ak_") })
	}

	@Test("invalid_token gets one new token, then succeeds")
	func invalidTokenRefreshes() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = ScriptedTransport([
			"/v2/device_tokens": [tokenReply("stale"), tokenReply("fresh")],
			"/v2/widget_summary": [errorReply(401, code: "invalid_credentials", challenge: "invalid_token"), summaryReply],
		])
		let attempt = await harness.fetcher(transport).fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		guard case .fetched = attempt else {
			Issue.record("expected a fetch, got \(attempt)")
			return
		}
		let auth = await transport.requests(to: "/v2/widget_summary").map { $0.value(forHTTPHeaderField: "Authorization") }
		#expect(auth == ["DPoP stale", "DPoP fresh"])
	}

	@Test("a revoked credential stops the widget until the app registers again")
	func revokedNeedsApp() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = ScriptedTransport([
			"/v2/device_tokens": [tokenReply("t1"), errorReply(401, code: "invalid_device_credential")],
			"/v2/widget_summary": [errorReply(401, code: "invalid_credentials", challenge: "invalid_token")],
		])
		let fetcher = harness.fetcher(transport)
		let first = await fetcher.fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		#expect(first == .failed)
		let state = harness.fetchStates.load(organizationId: organizationId)
		#expect(state.isCredentialRejected)
		#expect(state.lastOutcome == .unauthorized)

		let requestsBefore = await transport.requests.count
		let second = await fetcher.fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now.addingTimeInterval(120))
		#expect(second == .needsApp)
		#expect(await transport.requests.count == requestsBefore)
	}

	@Test("a proof refused twice backs off rather than calling it revoked")
	func proofRefusedTwice() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		let transport = ScriptedTransport([
			"/v2/device_tokens": [tokenReply("t1")],
			"/v2/widget_summary": [errorReply(401, code: "invalid_dpop_proof", challenge: "invalid_dpop_proof")],
		])
		let attempt = await harness.fetcher(transport).fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		#expect(attempt == .failed)
		#expect(await transport.requests(to: "/v2/widget_summary").count == 2)
		let state = harness.fetchStates.load(organizationId: organizationId)
		#expect(!state.isCredentialRejected)
		#expect(state.lastOutcome == .server)
	}

	@Test("a record whose key is gone asks for the app without a request")
	func missingKey() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		harness.keys.deleteAll()
		let transport = ScriptedTransport([:])
		let attempt = await harness.fetcher(transport).fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		#expect(attempt == .needsApp)
		#expect(await transport.requests.isEmpty)
		#expect(harness.fetchStates.load(organizationId: organizationId).isCredentialRejected)
	}

	@Test("an expired registration asks for the app and records it, without a request")
	func expired() async throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		let (record, _) = try harness.register()
		var expired = record
		expired.expiresAt = now.addingTimeInterval(-1)
		harness.credentials.saveDevice(expired)
		let transport = ScriptedTransport([:])
		let attempt = await harness.fetcher(transport).fetch(organizationId: organizationId, organizationName: nil, storedGeneratedAt: nil, now: now)
		#expect(attempt == .needsApp)
		#expect(await transport.requests.isEmpty)
		#expect(harness.fetchStates.load(organizationId: organizationId).isCredentialRejected)
	}

	@Test("sign-out and pruning remove the record and the cached token")
	func clearing() throws {
		let harness = Harness()
		defer { harness.cleanUp() }
		try harness.register()
		harness.credentials.saveToken(DeviceAccessToken(organizationId: organizationId, jkt: "j", accessToken: "t", expiresAt: now))
		harness.credentials.clear(organizationId: organizationId)
		#expect(harness.credentials.loadDevice(organizationId: organizationId) == nil)
		#expect(harness.credentials.loadToken(organizationId: organizationId) == nil)
	}
}
