import AppIntents
import Foundation

/// What the app does when Acknowledge is tapped on the Lock Screen card or in
/// the Dynamic Island.
///
/// A hook rather than the request itself, because this module is the one the
/// widget extension links and it must not carry the app's session or the
/// generated client. The app sets it once at launch; the extension never does,
/// and never needs to: a `LiveActivityIntent` is performed in the app's process.
public enum IncidentActivityActions {
	public typealias Acknowledge = @Sendable (_ incidentId: String, _ organizationId: String?) async -> Void

	@MainActor public static var acknowledge: Acknowledge?
}

#if os(iOS)
	/// Acknowledge the incident a Live Activity is showing, without opening the app.
	///
	/// iOS only: `LiveActivityIntent` does not exist on macOS, where this module is
	/// tested with plain `swift test`.
	public struct AcknowledgeIncidentIntent: LiveActivityIntent {
		public static let title: LocalizedStringResource = "Acknowledge incident"
		public static let description = IntentDescription("Acknowledges the incident this Live Activity shows.")
		/// Not something to offer in Shortcuts: it only means anything on its card.
		public static let isDiscoverable = false
		/// Answering a page should not wait on Face ID. Whether iOS honours this for
		/// a button on a locked screen is the system's call.
		public static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

		@Parameter(title: "Incident")
		public var incidentId: String

		@Parameter(title: "Organization")
		public var organizationId: String?

		public init() {}

		public init(incidentId: String, organizationId: String?) {
			self.incidentId = incidentId
			self.organizationId = organizationId
		}

		public func perform() async throws -> some IntentResult {
			await IncidentActivityActions.acknowledge?(incidentId, organizationId)
			return .result()
		}
	}
#endif
