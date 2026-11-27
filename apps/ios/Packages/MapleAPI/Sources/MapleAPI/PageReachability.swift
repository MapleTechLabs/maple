import Foundation

// Whether a page would reach this phone, and what to do when it would not.
// Kept in the package so the warning card and the settings sheet read one
// verdict, and so the order of the checks has tests.

/// What the phone knows about its own notifications and its registration.
public struct PageReachability: Hashable, Sendable {
	public enum Authorization: Hashable, Sendable {
		case notDetermined
		case denied
		case authorized
		/// Delivered quietly to Notification Center: no banner, no sound.
		case provisional
	}

	/// Whether the server holds this phone for the organization on screen.
	public enum Registration: Hashable, Sendable {
		case registered
		/// The token or the request is still on its way. Nothing to fix yet, so
		/// it is never reported as a problem.
		case pending
		/// No token arrived, or the server did not take it.
		case missing
	}

	public var authorization: Authorization
	/// `UNNotificationSettings.alertSetting`: banners may show.
	public var alertsEnabled: Bool
	public var soundEnabled: Bool
	/// `UNNotificationSettings.timeSensitiveSetting`: a page may break through Focus.
	public var timeSensitiveEnabled: Bool
	public var registration: Registration

	public init(
		authorization: Authorization,
		alertsEnabled: Bool = true,
		soundEnabled: Bool = true,
		timeSensitiveEnabled: Bool = true,
		registration: Registration = .registered
	) {
		self.authorization = authorization
		self.alertsEnabled = alertsEnabled
		self.soundEnabled = soundEnabled
		self.timeSensitiveEnabled = timeSensitiveEnabled
		self.registration = registration
	}

	/// What puts a problem right.
	public enum Fix: Hashable, Sendable {
		/// The system prompt, which iOS shows once per install.
		case requestPermission
		/// Maple's notification settings in the Settings app.
		case openSettings
		case retryRegistration
	}

	/// One thing between a page and this phone. The cases are in the order they
	/// are reported: the first that holds is the one shown.
	public enum Problem: String, Hashable, Sendable, CaseIterable {
		case permissionDenied = "permission_denied"
		case permissionNotAsked = "permission_not_asked"
		case deliveredQuietly = "delivered_quietly"
		case alertsOff = "alerts_off"
		case soundOff = "sound_off"
		case timeSensitiveOff = "time_sensitive_off"
		case notRegistered = "not_registered"

		public var title: String {
			switch self {
			case .permissionDenied, .permissionNotAsked: "Pages will not reach this phone"
			case .deliveredQuietly: "Pages arrive quietly on this phone"
			case .alertsOff: "Pages will not show on this phone"
			case .soundOff: "Pages arrive without a sound"
			case .timeSensitiveOff: "Focus can hold back a page"
			case .notRegistered: "This phone is not registered for pages"
			}
		}

		/// One line saying why.
		public var detail: String {
			switch self {
			case .permissionDenied: "Notifications are turned off for Maple."
			case .permissionNotAsked: "Maple has not been allowed to send notifications yet."
			case .deliveredQuietly: "Maple may only deliver quietly, with no banner or sound."
			case .alertsOff: "Banners are turned off for Maple."
			case .soundOff: "Sounds are turned off for Maple."
			case .timeSensitiveOff: "Time Sensitive notifications are off for Maple."
			case .notRegistered: "Maple could not register it to receive pages."
			}
		}

		public var fix: Fix {
			switch self {
			case .permissionNotAsked: .requestPermission
			// Once refused, iOS never shows the prompt again: only Settings can undo it.
			case .permissionDenied, .deliveredQuietly, .alertsOff, .soundOff, .timeSensitiveOff: .openSettings
			case .notRegistered: .retryRegistration
			}
		}

		/// The label on the one button that performs `fix`.
		public var fixTitle: String {
			switch self {
			case .permissionDenied: "Turn on notifications"
			case .permissionNotAsked: "Allow notifications"
			case .deliveredQuietly, .alertsOff, .soundOff, .timeSensitiveOff: "Open settings"
			case .notRegistered: "Try again"
			}
		}
	}

	public enum Verdict: Hashable, Sendable {
		case reachable
		case problem(Problem)
	}

	/// The most severe problem, or `.reachable`. Permission comes first because
	/// nothing below it matters without it; registration last, because a phone
	/// without permission never registers at all.
	public var verdict: Verdict {
		switch authorization {
		case .denied: return .problem(.permissionDenied)
		case .notDetermined: return .problem(.permissionNotAsked)
		case .provisional: return .problem(.deliveredQuietly)
		case .authorized: break
		}
		if !alertsEnabled { return .problem(.alertsOff) }
		if !soundEnabled { return .problem(.soundOff) }
		if !timeSensitiveEnabled { return .problem(.timeSensitiveOff) }
		if registration == .missing { return .problem(.notRegistered) }
		return .reachable
	}

	public var problem: Problem? {
		if case .problem(let problem) = verdict { return problem }
		return nil
	}
}

// MARK: - Who is warned

extension OnCallViewerState {
	/// How far ahead a shift may start and still earn the warning.
	public static let pageWarningLead: TimeInterval = 7 * 86_400

	/// On call now, or with a shift starting inside the lead. Someone further
	/// from a shift than that, or in no rotation, is not expecting a page.
	public func expectsPages(now: Date, within lead: TimeInterval = OnCallViewerState.pageWarningLead) -> Bool {
		switch self {
		case .onCall: true
		case .offCall(let next): next.start.timeIntervalSince(now) <= lead
		case .noShifts: false
		}
	}
}

extension PageReachability {
	/// The problem to warn about, only for someone a page could be meant for.
	public func warning(for state: OnCallViewerState, now: Date) -> Problem? {
		state.expectsPages(now: now) ? problem : nil
	}
}
