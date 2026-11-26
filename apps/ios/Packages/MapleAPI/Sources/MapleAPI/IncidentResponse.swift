import Foundation

/// Where an incident stands for whoever is holding the phone: nobody has it,
/// someone has it, or it is over.
///
/// Derived here, in the package, because every surface that answers a page
/// (the incident screen, the Triage rows, Overview, the notification) has to
/// say the same thing about the same incident, and this is the part with tests.
public enum IncidentResponseState: Hashable, Sendable {
	/// Open and unacknowledged. The page is set while an escalation run is
	/// waiting on its next step.
	case unacknowledged(NextPage?)
	case acknowledged(Acknowledgement)
	case resolved

	public struct Person: Hashable, Sendable {
		public let userId: String?
		public let name: String?

		public init(userId: String?, name: String?) {
			self.userId = userId
			self.name = name
		}
	}

	/// The escalation step an unacknowledged incident is waiting on.
	public struct NextPage: Hashable, Sendable {
		public let at: Date
		/// Who the step would page. Empty when it only notifies destinations, or
		/// its schedules have nobody on call.
		public let people: [Person]
		public let step: Int
		public let stepCount: Int
		public let pass: Int
		public let passCount: Int
		public let chainName: String

		public init(
			at: Date, people: [Person], step: Int, stepCount: Int, pass: Int = 1, passCount: Int = 1, chainName: String
		) {
			self.at = at
			self.people = people
			self.step = step
			self.stepCount = stepCount
			self.pass = pass
			self.passCount = passCount
			self.chainName = chainName
		}
	}

	public struct Acknowledgement: Hashable, Sendable {
		public let by: Person
		public let source: AlertIncidentAckSource?
		public let at: Date?
		/// Seconds the incident stood before anyone first acknowledged it.
		public let waited: TimeInterval?
		/// False when an earlier acknowledgement was cleared and this is a later one.
		public let isFirst: Bool

		public init(
			by: Person, source: AlertIncidentAckSource?, at: Date?, waited: TimeInterval?, isFirst: Bool = true
		) {
			self.by = by
			self.source = source
			self.at = at
			self.waited = waited
			self.isFirst = isFirst
		}
	}

	public var isUnacknowledged: Bool {
		if case .unacknowledged = self { return true }
		return false
	}
}

extension AlertIncident {
	public var responseState: IncidentResponseState {
		guard status == .open else { return .resolved }
		if acknowledgedAt != nil {
			return .acknowledged(
				.init(
					by: .init(userId: acknowledgedBy?.userId, name: acknowledgedBy?.name),
					source: acknowledgedVia,
					at: acknowledgedAt.flatMap(ResolvedTimeWindow.parse),
					waited: timeToAcknowledge,
					isFirst: acknowledgedAt == firstAcknowledgedAt
				)
			)
		}
		guard let escalation, escalation.status == .active,
			let at = escalation.nextStepAt.flatMap(ResolvedTimeWindow.parse)
		else { return .unacknowledged(nil) }
		return .unacknowledged(
			.init(
				at: at,
				people: escalation.nextStepPeople.map { .init(userId: $0.userId, name: $0.name) },
				step: escalation.step,
				stepCount: escalation.stepCount,
				pass: escalation.pass,
				passCount: escalation.passCount,
				chainName: escalation.chainName
			)
		)
	}

	/// Seconds from opening to the first acknowledgement, kept after an
	/// unacknowledge or the resolve. Nil when nobody ever acknowledged.
	public var timeToAcknowledge: TimeInterval? {
		guard let first = firstAcknowledgedAt.flatMap(ResolvedTimeWindow.parse),
			let opened = ResolvedTimeWindow.parse(firstTriggeredAt)
		else { return nil }
		let waited = first.timeIntervalSince(opened)
		return waited >= 0 ? waited : nil
	}
}

extension IncidentResponseState.Person {
	/// "you" for the person holding the phone, their name, or a stand-in when
	/// the directory could not name them.
	public func label(viewerUserId: String?, unnamed: String = "a teammate") -> String {
		if let userId, let viewerUserId, userId == viewerUserId { return "you" }
		return name ?? unnamed
	}
}

extension IncidentResponseState.NextPage {
	/// "Pages Priya Shah", "Pages Priya Shah and Dana Kim", "Pages Priya Shah +2".
	/// A step that names nobody says which step it is instead.
	public func headline(viewerUserId: String?) -> String {
		let names = people.map { $0.label(viewerUserId: viewerUserId) }
		switch names.count {
		case 0: return "Escalates to step \(step) of \(stepCount)"
		case 1: return "Pages \(names[0])"
		case 2: return "Pages \(names[0]) and \(names[1])"
		default: return "Pages \(names[0]) +\(names.count - 1)"
		}
	}

	/// The people alone, for a surface with no room for a sentence: "Priya Shah",
	/// "Priya Shah +1". Nil when the step names nobody.
	public func peopleSummary(viewerUserId: String?) -> String? {
		guard let first = people.first else { return nil }
		let name = first.label(viewerUserId: viewerUserId)
		return people.count == 1 ? name : "\(name) +\(people.count - 1)"
	}

	/// "Step 2 of 3", with the pass once the chain repeats.
	public var position: String {
		passCount > 1 ? "Step \(step) of \(stepCount), pass \(pass) of \(passCount)" : "Step \(step) of \(stepCount)"
	}

	/// `3m 48s`, `48s`, `1h 2m`: what is left before the step, and `now` once it
	/// is due. Seconds matter here, so this is not `Format.duration`.
	public func countdown(now: Date = Date()) -> String {
		let left = Int(at.timeIntervalSince(now).rounded(.down))
		if left <= 0 { return "now" }
		if left >= 3600 { return "\(left / 3600)h \((left % 3600) / 60)m" }
		if left >= 60 { return "\(left / 60)m \(left % 60)s" }
		return "\(left)s"
	}
}

extension IncidentResponseState.Acknowledgement {
	/// "Acknowledged by you", "Acknowledged by Dana Kim". An agent is named as
	/// one, as the web timeline does.
	public func headline(viewerUserId: String?) -> String {
		"Acknowledged by \(by.label(viewerUserId: viewerUserId, unnamed: source == .mcp ? "an agent over MCP" : "a teammate"))"
	}

	/// "2m after it opened", or "first acknowledged after 2m" when this is a later
	/// acknowledgement than the first. Nil when the wait is unknown.
	public var waitedText: String? {
		waited.map {
			isFirst ? "\(IncidentWording.span($0)) after it opened" : "first acknowledged after \(IncidentWording.span($0))"
		}
	}

	/// The headline and the wait on one line, as the web's incident rows read.
	public func summary(viewerUserId: String?) -> String {
		guard let waitedText else { return headline(viewerUserId: viewerUserId) }
		return "\(headline(viewerUserId: viewerUserId))\(isFirst ? "," : " ·") \(waitedText)"
	}
}

/// The words every surface uses for incident activity. They follow the web
/// timeline (`packages/web-data/src/alerts/incident-timeline.ts`) so the phone
/// and the browser describe one event the same way.
public enum IncidentWording {
	/// "under 1m", "4m", "1h 5m", "2d 1h".
	public static func span(_ seconds: TimeInterval) -> String {
		let minutes = Int(seconds / 60)
		if minutes < 1 { return "under 1m" }
		if minutes < 60 { return "\(minutes)m" }
		let hours = minutes / 60
		if hours < 24 {
			let rest = minutes % 60
			return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
		}
		let rest = hours % 24
		return rest == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(rest)h"
	}

	public static func source(_ source: AlertIncidentAckSource) -> String {
		switch source {
		case .web: "the dashboard"
		case .api: "the API"
		case .mcp: "MCP"
		case .slack: "Slack"
		case .discord: "Discord"
		case .mobile: "the mobile app"
		}
	}

	/// "email", "phone", "Slack DM".
	public static func pageChannel(_ channel: String) -> String {
		switch channel {
		case "email": "email"
		case "push": "phone"
		case "slack": "Slack DM"
		case "discord": "Discord DM"
		default: "\(channel) DM"
		}
	}
}

/// One line of an incident's activity, ready to draw.
public struct IncidentEventLine: Hashable, Sendable {
	public enum Tone: Hashable, Sendable {
		case neutral
		case info
		case warn
		case critical
		case good
	}

	public let title: String
	public let detail: String?
	public let tone: Tone

	public init(title: String, detail: String?, tone: Tone) {
		self.title = title
		self.detail = detail
		self.tone = tone
	}
}

extension AlertIncidentEvent {
	public func line(viewerUserId: String?) -> IncidentEventLine {
		let who = IncidentResponseState.Person(userId: actor?.userId, name: actor?.name)
			.label(viewerUserId: viewerUserId, unnamed: source == .mcp ? "an agent over MCP" : "a teammate")
		let from = source.map { "From \(IncidentWording.source($0))" }
		func detail(_ rest: String) -> String { [from, rest].compactMap { $0 }.joined(separator: " · ") }

		switch _type {
		case .acknowledged:
			return .init(title: "Acknowledged by \(who)", detail: detail("reminders paused"), tone: .info)
		case .unacknowledged:
			return .init(title: "Unacknowledged by \(who)", detail: detail("reminders resume"), tone: .neutral)
		case .ackCleared:
			return .init(
				title: "Acknowledgement cleared", detail: "The incident escalated, so it notified again", tone: .warn
			)
		case .resolved:
			return .init(
				title: "Resolved by \(who)",
				detail: detail("nothing reopens until the rule has been healthy once"),
				tone: .good
			)
		case .onCallGap:
			// With no schedule named, the step's own targets were all unreachable.
			return self.detail.map {
				.init(title: "Nobody on call on \($0)", detail: "The escalation step paged no one for it", tone: .warn)
			}
				?? .init(
					title: "An escalation step reached nobody",
					detail: "Its destinations are off or its people have left the organization",
					tone: .warn
				)
		case .paged:
			guard let page else { return .init(title: "Paged a member", detail: nil, tone: .neutral) }
			let person = IncidentResponseState.Person(userId: page.userId, name: page.name)
				.label(viewerUserId: viewerUserId, unnamed: "a member")
			let by = IncidentWording.pageChannel(page.channel)
			switch page.status {
			case .failed:
				return .init(
					title: "Couldn't page \(person) by \(by)",
					detail: page.errorMessage ?? "The channel refused it",
					tone: .critical
				)
			case .skipped:
				return .init(
					title: "Skipped paging \(person) by \(by)",
					detail: page.errorMessage ?? "Acknowledged or resolved first",
					tone: .neutral
				)
			case .queued, .sending:
				// A pending page with an error is between retries.
				return .init(
					title: "Paging \(person) by \(by)",
					detail: page.errorMessage.map { "Retrying: \($0)" },
					tone: .neutral
				)
			case .sent:
				return .init(title: "Paged \(person) by \(by)", detail: nil, tone: .info)
			}
		}
	}
}

extension Sequence where Element == AlertIncidentEvent {
	/// Whether an escalation step paged this person, on any channel.
	public func paged(userId: String?) -> Bool {
		guard let userId else { return false }
		return contains { $0._type == .paged && $0.page?.userId == userId }
	}
}
