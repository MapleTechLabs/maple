import Foundation

/// The widget extension's own client for `GET /v2/widget_summary`.
///
/// Hand-written, and deliberately so. The extension does not link `MapleAPI`:
/// that is 30k lines of generated code plus `OpenAPIRuntime`, inside a process
/// the system gives roughly 30MB and a few seconds of wall clock. One endpoint
/// it can decode by hand is the only shape that fits — which is also why the
/// endpoint exists at all.
///
/// Everything here is written so that **failing changes nothing**. A widget
/// never shows an error; it shows the last snapshot it has, with an honest age.
/// So the fetch is an enrichment of a timeline that was already going to be
/// built, never a precondition for building one.
public actor WidgetSummaryFetcher {
	/// Shared per process. WidgetKit builds each pinned instance's timeline
	/// separately — issues-small, issues-medium and throughput can all be woken
	/// for the same organization at once — and without one place to coalesce
	/// them that is three identical requests for one answer.
	public static let shared = WidgetSummaryFetcher()

	/// The provider's whole budget, not just the request's.
	///
	/// The system kills a slow timeline provider, and a killed provider costs a
	/// rebuild from a metered budget having rendered nothing. Five seconds is
	/// enough for a small payload on a bad connection and short enough to leave
	/// room to fall back and still return a timeline.
	public static let deadline: TimeInterval = 5

	/// Below this age, the stored snapshot is used as-is.
	///
	/// The app publishes on every foreground, so without a floor a widget woken
	/// moments later would re-fetch what it already has.
	public static let freshnessFloor: TimeInterval = 2 * 60

	/// How long an in-flight attempt suppresses another one.
	///
	/// The in-process coalescing below covers three providers in one extension;
	/// this covers the app and the extension racing, which are different
	/// processes and share nothing but the App Group.
	public static let attemptLock: TimeInterval = 60

	private let credentials: WidgetCredentialStore
	private let fetchStates: WidgetFetchStateStore
	private let keys: any DeviceKeyStoring
	private let tokens: DeviceTokenClient
	private let session: any WidgetHTTPTransport
	private var inFlight: [String: Task<WidgetSummaryPayload?, Never>] = [:]

	public init(
		credentials: WidgetCredentialStore = WidgetCredentialStore(),
		fetchStates: WidgetFetchStateStore = WidgetFetchStateStore(),
		keys: any DeviceKeyStoring = KeychainDeviceKeyStore(),
		tokens: DeviceTokenClient? = nil,
		session: (any WidgetHTTPTransport)? = nil
	) {
		self.credentials = credentials
		self.fetchStates = fetchStates
		self.keys = keys
		let session = session ?? Self.makeSession()
		self.session = session
		self.tokens = tokens ?? DeviceTokenClient(transport: session, store: credentials)
	}

	/// The extension's session: the provider's deadline, no waiting.
	public static func makeSession() -> URLSession {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = WidgetSummaryFetcher.deadline
		configuration.timeoutIntervalForResource = WidgetSummaryFetcher.deadline
		// A provider that waits for connectivity is a provider that gets
		// killed. Offline is an answer here, and a fast one.
		configuration.waitsForConnectivity = false
		return URLSession(configuration: configuration)
	}

	/// How a request authenticates: the device-bound key, or the legacy
	/// `maple_ak_` bearer an older API still issues.
	enum Authorization: Sendable {
		case device(DeviceCredential, DeviceKey)
		case legacy(WidgetCredential)

		var scheme: String {
			switch self {
			case .device: "dpop"
			case .legacy: "bearer"
			}
		}
	}

	/// Why a fetch was skipped, or that one ran. Returned so a caller can put it
	/// on a timeline policy without re-deriving it.
	public enum Attempt: Sendable, Equatable {
		/// The stored snapshot is younger than `freshnessFloor`.
		case fresh
		/// No credential yet: the app has not run, or has not covered this
		/// organization.
		case noCredential
		/// The credential has expired, or the server rejected it. Only the app
		/// can fix either.
		case needsApp
		/// Another provider — or the app — is already on it.
		case coalesced
		case fetched(WidgetSummaryPayload)
		case failed
	}

	/// Fetch this organization's summary, unless there is a reason not to.
	///
	/// Writes a successful payload's snapshots into the App Group **before**
	/// returning, so a provider killed on the way to rendering still leaves the
	/// data behind for the next rebuild.
	/// - Parameter environment: the deployment environment to filter to, or nil
	///   for the whole organization. It selects the snapshot slot as well as the
	///   query, so two widgets on one organization can hold different answers.
	public func fetch(
		organizationId: String,
		organizationName: String?,
		environment: String? = nil,
		storedGeneratedAt: Date?,
		now: Date = Date()
	) async -> Attempt {
		if let storedGeneratedAt, now.timeIntervalSince(storedGeneratedAt) < Self.freshnessFloor {
			return .fresh
		}

		let state = fetchStates.load(organizationId: organizationId)
		// A rolled credential answers 401 forever. Retrying on every rebuild
		// would spend the entire refresh budget on failures and leave the widget
		// no fresher than not trying at all.
		if state.isCredentialRejected { return .needsApp }
		// The app and the extension are different processes and share nothing but
		// the App Group, so this is the only thing standing between them when a
		// foreground and a timeline rebuild land in the same second.
		//
		// Per organization, not per environment: the state it guards is the
		// credential's, and a credential is bound to an organization. The cost
		// is that a staging widget can be told `.coalesced` while production is
		// fetching — which it answers by rendering its own stored snapshot with
		// an honest age, the same thing it does for every other skip.
		if state.isInFlight(at: now, within: Self.attemptLock) { return .coalesced }

		// The device credential wins whenever the app has registered one.
		let authorization: Authorization
		if let device = credentials.loadDevice(organizationId: organizationId) {
			if device.isExpired(at: now) { return .needsApp }
			// The record without its key (a restored backup, a wiped keychain) is
			// a credential nothing can sign for. Recorded so the app re-registers.
			guard let key = keys.load(organizationId: organizationId), key.thumbprint == device.jkt else {
				fetchStates.save(state.recording(.unauthorized, at: now), organizationId: organizationId)
				return .needsApp
			}
			authorization = .device(device, key)
		} else if let credential = credentials.load(organizationId: organizationId) {
			// Expiry is checked here rather than left to the 401: a credential the
			// app has simply not renewed yet is not a rejected one, and spending a
			// request to be told so helps nobody.
			if credential.isExpired(at: now) { return .needsApp }
			authorization = .legacy(credential)
		} else {
			return .noCredential
		}

		// Keyed by organization *and* environment: within this process two
		// widgets asking for different environments are asking different
		// questions, and folding them together would hand one of them the
		// other's answer.
		let inFlightKey = "\(organizationId)|\(environment ?? "")"
		if let existing = inFlight[inFlightKey] {
			return await existing.value.map(Attempt.fetched) ?? .coalesced
		}

		// Stamped before the request goes out, so a second process starting in
		// the same second sees an attempt in progress rather than none.
		fetchStates.save(state.attempting(at: now), organizationId: organizationId)

		let task = Task<WidgetSummaryPayload?, Never> { [credentials, fetchStates, session, tokens] in
			let outcome = await Self.request(
				authorization: authorization,
				environment: environment,
				session: session,
				tokens: tokens,
				now: now
			)
			switch outcome {
			case .success(let payload):
				// The organization the credential is bound to is the one the
				// server answers for. A disagreement would write one
				// organization's numbers under another's name — invisible until
				// someone reads the wrong figure off their Home Screen.
				//
				// The environment is checked for the same reason and is the more
				// likely of the two to disagree: a server that predates the
				// parameter answers organization-wide, cheerfully, with a 200.
				// Writing that into the staging slot would put production's
				// numbers under a staging label.
				guard payload.organizationId == organizationId,
					payload.deploymentEnvironment == environment,
					payload.isSupported
				else {
					fetchStates.save(
						fetchStates.load(organizationId: organizationId)
							.recording(.undecodable, at: Date(), authScheme: authorization.scheme),
						organizationId: organizationId
					)
					return nil
				}
				// Saved before the caller gets it back: a provider killed between
				// here and rendering still leaves the data for the next rebuild.
				WidgetSnapshotStore<IssuesSnapshot>
					.issues(organizationId: organizationId, environment: environment)
					.save(payload.issuesSnapshot(organizationName: organizationName))
				WidgetSnapshotStore<ThroughputSnapshot>
					.throughput(organizationId: organizationId, environment: environment)
					.save(payload.throughputSnapshot())
				fetchStates.save(
					fetchStates.load(organizationId: organizationId)
						.recording(.success, at: Date(), authScheme: authorization.scheme),
					organizationId: organizationId
				)
				_ = credentials
				return payload
			case .failure(let reason):
				fetchStates.save(
					fetchStates.load(organizationId: organizationId)
						.recording(reason, at: Date(), authScheme: authorization.scheme),
					organizationId: organizationId
				)
				return nil
			}
		}
		inFlight[inFlightKey] = task
		let payload = await task.value
		inFlight[inFlightKey] = nil
		return payload.map(Attempt.fetched) ?? .failed
	}

	enum RequestOutcome {
		case success(WidgetSummaryPayload)
		case failure(WidgetFetchState.Outcome)
	}

	static func request(
		authorization: Authorization,
		environment: String?,
		session: any WidgetHTTPTransport,
		tokens: DeviceTokenClient,
		now: Date
	) async -> RequestOutcome {
		switch authorization {
		case .legacy(let credential):
			var request = summaryRequest(baseURL: credential.apiBaseURL, environment: environment)
			request.setValue("Bearer \(credential.secret)", forHTTPHeaderField: "Authorization")
			return await send(request, session: session)
		case .device(let credential, let key):
			return await deviceRequest(
				credential: credential,
				key: key,
				environment: environment,
				session: session,
				tokens: tokens,
				now: now
			)
		}
	}

	/// `GET /v2/widget_summary` with a DPoP-bound token.
	///
	/// `invalid_token` earns one fresh token and `invalid_dpop_proof` one fresh
	/// proof; a second refusal, or `invalid_device_credential`, waits for the app.
	static func deviceRequest(
		credential: DeviceCredential,
		key: DeviceKey,
		environment: String?,
		session: any WidgetHTTPTransport,
		tokens: DeviceTokenClient,
		now: Date
	) async -> RequestOutcome {
		var refreshedToken = false
		var retriedProof = false
		while true {
			let token: DeviceAccessToken
			switch await tokens.token(for: credential, key: key, forceRefresh: refreshedToken, now: now) {
			case .success(let value): token = value
			case .failure(.needsApp): return .failure(.unauthorized)
			case .failure(.unreachable): return .failure(.unreachable)
			case .failure(.server): return .failure(.server)
			}
			var request = summaryRequest(baseURL: credential.apiBaseURL, environment: environment)
			guard let url = request.url,
				let proof = try? DPoPProof.make(
					key: key.signer,
					method: "GET",
					url: url,
					accessToken: token.accessToken,
					issuedAt: await tokens.issuedAt(now)
				)
			else { return .failure(.unauthorized) }
			request.setValue("DPoP \(token.accessToken)", forHTTPHeaderField: "Authorization")
			request.setValue(proof, forHTTPHeaderField: "DPoP")

			let data: Data
			let response: HTTPURLResponse
			do {
				(data, response) = try await session.send(request)
			} catch {
				return .failure(.unreachable)
			}
			await tokens.observe(response, at: now)
			guard response.statusCode == 401 else { return outcome(status: response.statusCode, data: data) }
			let error = DeviceAuthError(status: 401, data: data, headers: response.allHeaderFields)
			if error.isInvalidProof, !retriedProof {
				retriedProof = true
				continue
			}
			// A proof refused twice is a clock or a bug, not a revoked key: back off.
			if error.isInvalidProof { return .failure(.server) }
			if !refreshedToken {
				refreshedToken = true
				continue
			}
			return .failure(.unauthorized)
		}
	}

	private static func summaryRequest(baseURL: URL, environment: String?) -> URLRequest {
		let path = baseURL.appendingPathComponent("v2/widget_summary")
		// `URLComponents` rather than string interpolation: environment names
		// are user-defined and may carry a space or a slash, which would
		// otherwise produce a URL that silently fails to build.
		var components = URLComponents(url: path, resolvingAgainstBaseURL: false)
		if let environment, !environment.isEmpty {
			components?.queryItems = [URLQueryItem(name: "deployment_environment", value: environment)]
		}
		var request = URLRequest(url: components?.url ?? path, timeoutInterval: deadline)
		request.httpMethod = "GET"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		// Deliberately no `x-maple-org-id`. Both credentials are already bound
		// to one organization, so the only way to get this wrong is to send it.
		return request
	}

	private static func send(_ request: URLRequest, session: any WidgetHTTPTransport) async -> RequestOutcome {
		do {
			let (data, response) = try await session.send(request)
			return outcome(status: response.statusCode, data: data)
		} catch {
			// Offline, DNS, TLS, or the deadline. All the same to a widget: try
			// again sooner than a server error, and render what it has meanwhile.
			return .failure(.unreachable)
		}
	}

	private static func outcome(status: Int, data: Data) -> RequestOutcome {
		switch status {
		case 200:
			// `WidgetJSON.decoder`, never a plain `.iso8601` one: the API sends
			// timestamps with milliseconds and `.iso8601` rejects those on the
			// deployment target. See WidgetJSON.
			guard let payload = try? WidgetJSON.decoder.decode(WidgetSummaryPayload.self, from: data)
			else {
				return .failure(.undecodable)
			}
			return .success(payload)
		// 403 belongs here too: a credential whose scopes no longer reach
		// this endpoint is as dead as one that was revoked, and the app is
		// the only thing that can mint a working replacement.
		case 401, 403:
			return .failure(.unauthorized)
		default:
			return .failure(.server)
		}
	}
}
