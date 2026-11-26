import Foundation

/// One request signed with a device credential: a DPoP-bound access token and a
/// fresh proof over this method and URL.
///
/// `invalid_token` earns one fresh token and `invalid_dpop_proof` one fresh
/// proof; a second refusal, or `invalid_device_credential`, waits for the app.
/// Shared by every widget request so they cannot disagree about that ladder.
enum DeviceRequest {
	struct Response: Sendable {
		let data: Data
		let status: Int
	}

	/// The server's answer, whatever its status, or why there was none.
	enum Sent: Sendable {
		case response(Response)
		case failure(WidgetFetchState.Outcome)
	}

	/// - Parameter make: builds the request. Called once per attempt, because a
	///   retry needs a fresh proof and must not reuse a consumed body stream.
	static func send(
		_ make: @Sendable () -> URLRequest,
		credential: DeviceCredential,
		key: DeviceKey,
		session: any WidgetHTTPTransport,
		tokens: DeviceTokenClient,
		now: Date
	) async -> Sent {
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
			var request = make()
			guard let url = request.url,
				let proof = try? DPoPProof.make(
					key: key.signer,
					method: request.httpMethod ?? "GET",
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
				// Offline, DNS, TLS, or the deadline. All the same to a widget.
				return .failure(.unreachable)
			}
			await tokens.observe(response, at: now)
			guard response.statusCode == 401 else { return .response(Response(data: data, status: response.statusCode)) }
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
}
