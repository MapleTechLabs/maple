import Foundation
import OpenAPIRuntime

/// Which alert events a phone wants. Mirrors `MobileDevicePreferences` on the
/// wire; every field is sent so the server's merge is total.
public struct PushPreferences: Hashable, Sendable, Codable {
	public var criticalIncidents: Bool
	public var warningIncidents: Bool
	public var resolvedIncidents: Bool
	public var newErrorIssues: Bool
	public var anomalies: Bool

	public init(
		criticalIncidents: Bool = true,
		warningIncidents: Bool = false,
		resolvedIncidents: Bool = false,
		newErrorIssues: Bool = false,
		anomalies: Bool = false
	) {
		self.criticalIncidents = criticalIncidents
		self.warningIncidents = warningIncidents
		self.resolvedIncidents = resolvedIncidents
		self.newErrorIssues = newErrorIssues
		self.anomalies = anomalies
	}

	/// The server's defaults — what a device gets before it has said anything:
	/// critical incidents only. Kept in step with
	/// `resolveMobileDevicePreferences` in `@maple/domain`.
	public static let `default` = PushPreferences()

	public init(_ wire: MobileDevice.PreferencesPayload) {
		self.init(
			criticalIncidents: wire.criticalIncidents,
			warningIncidents: wire.warningIncidents,
			resolvedIncidents: wire.resolvedIncidents,
			newErrorIssues: wire.newErrorIssues,
			anomalies: wire.anomalies
		)
	}

	var wire: Components.Schemas._MapleMobileDevicePreferences {
		.init(
			anomalies: anomalies,
			criticalIncidents: criticalIncidents,
			newErrorIssues: newErrorIssues,
			resolvedIncidents: resolvedIncidents,
			warningIncidents: warningIncidents
		)
	}
}

public struct DeviceRegistration: Hashable, Sendable {
	public var token: String
	public var environment: PushEnvironment
	public var bundleId: String
	public var appVersion: String?
	public var deviceName: String?
	public var preferences: PushPreferences?
	/// ActivityKit's push-to-start token, when the OS has issued one. Nil leaves
	/// whatever the server already has — an app build that cannot produce one
	/// must not erase the token a previous build registered.
	public var liveActivityStartToken: String?

	public init(
		token: String,
		environment: PushEnvironment,
		bundleId: String,
		appVersion: String? = nil,
		deviceName: String? = nil,
		preferences: PushPreferences? = nil,
		liveActivityStartToken: String? = nil
	) {
		self.token = token
		self.environment = environment
		self.bundleId = bundleId
		self.appVersion = appVersion
		self.deviceName = deviceName
		self.preferences = preferences
		self.liveActivityStartToken = liveActivityStartToken
	}
}

/// What a test page came to: how many of the caller's phones it was sent to.
public struct TestPageResult: Hashable, Sendable {
	/// False on a deployment without push credentials: nothing was tried.
	public let configured: Bool
	public let sent: Int
	public let failed: Int
	/// Phones the push platform no longer knows, dropped by the server.
	public let unregistered: Int

	public init(configured: Bool, sent: Int, failed: Int = 0, unregistered: Int = 0) {
		self.configured = configured
		self.sent = sent
		self.failed = failed
		self.unregistered = unregistered
	}

	public enum Outcome: String, Hashable, Sendable {
		case sent
		case noPhone = "no_phone"
		case notConfigured = "not_configured"
		case failed
	}

	/// One phone reached counts as sent, whatever happened to the others.
	public var outcome: Outcome {
		if !configured { return .notConfigured }
		if sent > 0 { return .sent }
		return failed > 0 ? .failed : .noPhone
	}

	/// The line under the button once the request has answered.
	public var message: String {
		switch outcome {
		case .sent: sent > 1 ? "Sent to \(sent) phones." : "Sent to this phone. It should arrive in a few seconds."
		case .noPhone: "No phone is registered for you here. Open Maple on your phone and allow notifications."
		case .notConfigured: "Push is not set up on this deployment."
		case .failed: Self.failureMessage
		}
	}

	/// Also the line for a request that never answered.
	public static let failureMessage = "The test page could not be sent."
}

extension MapleClient {
	/// A page with nothing behind it, to the caller's own phones in this organization.
	public func sendTestPage() async throws -> TestPageResult {
		try await mapping {
			let page = try await client.sendMobileTestPage(.init()).ok.body.json
			return TestPageResult(
				configured: page.configured, sent: page.sent, failed: page.failed, unregistered: page.unregistered
			)
		}
	}

	public func registerDevice(_ registration: DeviceRegistration) async throws -> MobileDevice {
		try await mapping {
			let output = try await client.registerMobileDevice(
				.init(
					path: .init(token: registration.token),
					body: .json(
						.init(
							appVersion: registration.appVersion,
							bundleId: registration.bundleId,
							deviceName: registration.deviceName,
							environment: registration.environment,
							liveActivityStartToken: registration.liveActivityStartToken,
							platform: .ios,
							preferences: registration.preferences?.wire
						)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	public func unregisterDevice(token: String) async throws {
		try await mapping {
			_ = try await client.unregisterMobileDevice(.init(path: .init(token: token))).ok
		}
	}

	/// Hands the server the update token for an activity this phone just
	/// started, so incident updates and the final "resolved" can reach it.
	public func registerLiveActivity(
		deviceToken: String,
		incidentId: String,
		activityId: String,
		pushToken: String
	) async throws {
		try await mapping {
			_ = try await client.registerLiveActivity(
				.init(
					path: .init(token: deviceToken, incidentId: incidentId),
					body: .json(.init(activityId: activityId, pushToken: pushToken))
				)
			).ok
		}
	}

	/// The activity is gone from this phone — dismissed, or ended locally.
	public func endLiveActivity(deviceToken: String, incidentId: String) async throws {
		try await mapping {
			_ = try await client.endLiveActivity(
				.init(path: .init(token: deviceToken, incidentId: incidentId))
			).ok
		}
	}

	public func myDevices() async throws -> [MobileDevice] {
		try await mapping {
			try await client.listMobileDevices(.init()).ok.body.json.data
		}
	}
}
