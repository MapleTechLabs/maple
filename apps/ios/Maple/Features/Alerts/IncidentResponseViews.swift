import MapleAPI
import SwiftUI

/// What a responder does to an incident from the phone. The same three v2
/// operations the web incident page calls.
enum IncidentAction: String, Hashable {
	case acknowledge
	case unacknowledge
	case resolve

	var failure: String {
		switch self {
		case .acknowledge: "Couldn't acknowledge the incident. Try again."
		case .unacknowledge: "Couldn't unacknowledge the incident. Try again."
		case .resolve: "Couldn't resolve the incident. Try again."
		}
	}
}

/// Bumped whenever an incident is answered from the phone, on any surface, so
/// every list still showing it reloads instead of going on saying it is waiting.
@MainActor
@Observable
final class IncidentChanges {
	static let shared = IncidentChanges()

	private(set) var revision = 0

	func didChange() {
		revision += 1
	}
}

/// Runs one incident action at a time for a screen and holds what the screen
/// shows meanwhile: which button is busy, and why the last one failed.
@MainActor
@Observable
final class IncidentResponder {
	/// Where an action was taken, for the span.
	enum Surface: String {
		case incident
		case triage
		case overview
		case notification
		case liveActivity = "live_activity"
	}

	struct Pending: Equatable {
		let incidentId: String
		let action: IncidentAction
	}

	private(set) var pending: Pending?
	var error: String?

	private let api: any MapleAPI
	private let surface: Surface
	/// The `IncidentChanges` revision this screen's content already reflects.
	private var seenRevision = IncidentChanges.shared.revision

	init(api: any MapleAPI, surface: Surface) {
		self.api = api
		self.surface = surface
	}

	func isPending(_ action: IncidentAction, on incidentId: String) -> Bool {
		pending == Pending(incidentId: incidentId, action: action)
	}

	/// The request itself, with its span and event. Shared with the banner's
	/// Acknowledge, which runs with no screen and no responder.
	static func send(_ action: IncidentAction, on incidentId: String, api: any MapleAPI, surface: Surface) async throws
		-> AlertIncident
	{
		let incident = try await Telemetry.span(
			Telemetry.Name.incidentAction,
			attributes: [
				Telemetry.Key.incidentAction: .string(action.rawValue),
				Telemetry.Key.incidentActionSurface: .string(surface.rawValue),
			]
		) { _ in
			switch action {
			case .acknowledge: try await api.acknowledgeIncident(id: incidentId)
			case .unacknowledge: try await api.unacknowledgeIncident(id: incidentId)
			case .resolve: try await api.resolveIncident(id: incidentId)
			}
		}
		Telemetry.track(Telemetry.Event.incidentActed, ["action": action.rawValue, "surface": surface.rawValue])
		IncidentChanges.shared.didChange()
		return incident
	}

	/// Run an action for a screen. `apply` puts the server's answer on screen at
	/// once; the reload that follows brings what the answer does not carry, and
	/// supersedes any load that read the incident before the write.
	///
	/// A failure reloads too: its usual cause is a row that went stale (resolved
	/// or acknowledged by someone else), and leaving it up invites the same tap.
	func perform<Value>(
		_ action: IncidentAction,
		on incidentId: String,
		in loader: ScreenLoader<Value>,
		apply: (inout Value, AlertIncident) -> Void
	) async {
		guard pending == nil else { return }
		pending = Pending(incidentId: incidentId, action: action)
		let generation = loader.generation
		do {
			let incident = try await Self.send(action, on: incidentId, api: api, surface: surface)
			loader.update(ifGeneration: generation) { value in
				var next = value
				apply(&next, incident)
				return next
			}
		} catch is CancellationError {
			pending = nil
			return
		} catch let error as MapleAPIError {
			self.error = error.message
		} catch {
			self.error = action.failure
		}
		pending = nil
		seenRevision = IncidentChanges.shared.revision
		await loader.load(.afterWrite)
	}

	/// Reload when an incident was answered since this screen last loaded: on
	/// another screen, from a banner, or while this one was off screen. Keyed
	/// with `.task(id: IncidentChanges.shared.revision)`, which also runs on
	/// appear, so a list that was not mounted when it happened still catches up.
	func reloadIfAnswered<Value>(_ loader: ScreenLoader<Value>) async {
		let revision = IncidentChanges.shared.revision
		guard revision != seenRevision else { return }
		seenRevision = revision
		guard loader.state.hasContent else { return }
		await loader.load(.afterWrite)
	}
}

extension View {
	/// The alert a failed incident action raises, the same on every screen.
	func incidentActionAlert(_ responder: IncidentResponder?) -> some View {
		alert(
			"Couldn't update",
			isPresented: Binding(
				get: { responder?.error != nil },
				set: { if !$0 { responder?.error = nil } }
			)
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(responder?.error ?? "")
		}
	}
}

// MARK: - Page strip

/// The card under an open incident's headline that says who has it: nobody yet
/// (and who gets paged next, and when), or the person who acknowledged.
struct IncidentPageStrip: View {
	let incident: AlertIncident
	/// An escalation step paged the person holding the phone for this incident.
	let pagedViewer: Bool
	let viewerUserId: String?
	/// Called a few seconds after the next step was due, to read what it did.
	var onDue: () async -> Void = {}

	/// How long after the step's time the scheduler has had to send it.
	private static let dueGrace: Duration = .seconds(8)

	var body: some View {
		switch incident.responseState {
		case .unacknowledged(let next):
			if let next {
				waiting(next)
					.task(id: next.at) {
						let wait = next.at.timeIntervalSinceNow
						try? await Task.sleep(for: .seconds(max(0, wait)) + Self.dueGrace)
						guard !Task.isCancelled else { return }
						await onDue()
					}
			} else if pagedViewer {
				unanswered
			}
		case .acknowledged(let acknowledgement):
			acknowledged(acknowledgement)
		case .resolved:
			EmptyView()
		}
	}

	private func waiting(_ next: IncidentResponseState.NextPage) -> some View {
		VStack(alignment: .leading, spacing: 9) {
			HStack(alignment: .firstTextBaseline) {
				Text(pagedViewer ? "Paged to you" : "Unacknowledged")
					.sectionLabelStyle(tint: incident.severity.tint)
				Spacer(minLength: 8)
				Text(next.position)
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
			HStack(alignment: .firstTextBaseline) {
				Text("\(next.headline(viewerUserId: viewerUserId)) at \(Format.clock(next.at))")
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(2)
				Spacer(minLength: 8)
				PageCountdown(next: next)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
			}
			StepSegments(step: next.step, count: next.stepCount, tint: incident.severity.tint)
			Text(next.chainName)
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
		}
		.padding(.leading, 14)
		.padding(.trailing, 12)
		.padding(.vertical, 12)
		.severityRail(incident.severity.tint)
		.hairlineCard()
		.padding(.horizontal, 16)
		.accessibilityElement(children: .combine)
	}

	private var unanswered: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("Paged to you")
				.sectionLabelStyle(tint: incident.severity.tint)
			Text("Nobody has acknowledged this yet.")
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
		}
		.padding(.leading, 14)
		.padding(.trailing, 12)
		.padding(.vertical, 12)
		.severityRail(incident.severity.tint)
		.hairlineCard()
		.padding(.horizontal, 16)
		.accessibilityElement(children: .combine)
	}

	/// A run that had ended (every step sent, or superseded) has nothing left to pause.
	private var pausesEscalation: Bool {
		guard let status = incident.escalation?.status else { return false }
		return status == .active || status == .acknowledged
	}

	private func acknowledged(_ acknowledgement: IncidentResponseState.Acknowledgement) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(alignment: .firstTextBaseline, spacing: 6) {
				PixelIcon.circleCheck.image
					.resizable()
					.frame(width: 14, height: 14)
					.foregroundStyle(Token.foreground)
					.alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
				Text(acknowledgement.headline(viewerUserId: viewerUserId))
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Spacer(minLength: 8)
				if let waited = acknowledgement.waitedText {
					Text(waited)
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
			}
			Text(pausesEscalation ? "Escalation and reminders are paused." : "Reminders are paused.")
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
		}
		.hairlineCard(padding: 12)
		.padding(.horizontal, 16)
		.accessibilityElement(children: .combine)
	}
}

/// `3m 48s`, ticking, then `now`. Once a second, and only while it is on screen.
struct PageCountdown: View {
	let next: IncidentResponseState.NextPage

	var body: some View {
		TimelineView(.periodic(from: .now, by: 1)) { context in
			let left = next.countdown(now: context.date)
			Text(left)
				.tabularNumbers()
				.fixedSize()
				.accessibilityLabel(left == "now" ? "Next page due now" : "Next page in \(left)")
		}
	}
}

/// One bar per chain step, filled up to the step last paged.
private struct StepSegments: View {
	/// The next step to page, from 1.
	let step: Int
	let count: Int
	let tint: Color

	var body: some View {
		HStack(spacing: 3) {
			ForEach(0..<max(count, 1), id: \.self) { index in
				Capsule()
					.fill(index < step - 1 ? tint : Token.input)
					.frame(height: 3)
			}
		}
		.accessibilityHidden(true)
	}
}

// MARK: - Buttons

/// The amber Acknowledge button, at the size its surface asks for. The one
/// primary action on any screen showing an unacknowledged page.
struct AcknowledgeButton: View {
	enum Size {
		/// In a list row or card footer.
		case compact
		/// The incident screen's action bar.
		case bar
	}

	var size: Size = .compact
	/// The rule the page is for, so VoiceOver can tell two buttons apart.
	let ruleName: String
	let isPending: Bool
	/// Another incident's action is still running: one at a time.
	var isBusy = false
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Text(isPending ? "Acknowledging…" : "Acknowledge")
				.font(size == .bar ? Typo.bodyMedium : Typo.smallMedium)
				.foregroundStyle(Token.primaryForeground)
				.lineLimit(1)
				.padding(.horizontal, size == .bar ? 0 : 14)
				.frame(maxWidth: size == .bar ? .infinity : nil)
				.frame(height: size == .bar ? 44 : 36)
				.background(Token.primary, in: .rect(cornerRadius: Token.Radius.md))
				.opacity(isBusy && !isPending ? 0.5 : 1)
				.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.disabled(isPending || isBusy)
		.accessibilityLabel(isPending ? "Acknowledging \(ruleName)" : "Acknowledge \(ruleName)")
	}
}

/// The bar under an open incident: the one thing to do next, and a menu for
/// the rest. It stands where the tab bar would be on this screen.
struct IncidentActionBar: View {
	let incident: AlertIncident
	let responder: IncidentResponder
	let perform: (IncidentAction) -> Void

	@State private var confirmsResolve = false

	private var isAcknowledged: Bool { incident.acknowledgedAt != nil }

	var body: some View {
		VStack(spacing: 0) {
			Hairline()
			buttons
				.padding(.horizontal, 16)
				.padding(.top, 12)
				.padding(.bottom, 8)
		}
		.background { Token.background.ignoresSafeArea(edges: .bottom) }
		.confirmationDialog("Resolve this incident?", isPresented: $confirmsResolve, titleVisibility: .visible) {
			Button("Resolve incident") { perform(.resolve) }
			Button("Cancel", role: .cancel) {}
		} message: {
			Text(
				"Everyone this incident notified gets the all-clear, and its escalation stops. If the rule still breaches, no new incident opens for it until a check reads healthy or reads no data, and for a day at most."
			)
		}
	}

	private var buttons: some View {
		HStack(spacing: 8) {
			if isAcknowledged {
				Button { confirmsResolve = true } label: {
					Text(responder.isPending(.resolve, on: incident.id) ? "Resolving…" : "Resolve")
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.frame(maxWidth: .infinity)
						.frame(height: 44)
						.overlay(RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.input, lineWidth: 1))
						.contentShape(.rect)
				}
				.buttonStyle(.plain)
			} else {
				AcknowledgeButton(
					size: .bar,
					ruleName: incident.ruleName,
					isPending: responder.isPending(.acknowledge, on: incident.id)
				) {
					perform(.acknowledge)
				}
			}
			Menu {
				if isAcknowledged {
					Button("Unacknowledge", systemImage: "arrow.uturn.backward") { perform(.unacknowledge) }
				} else {
					Button("Resolve", systemImage: "checkmark.circle") { confirmsResolve = true }
				}
			} label: {
				PixelIcon.dotsVertical.image
					.resizable()
					.frame(width: 16, height: 16)
					.foregroundStyle(Token.foreground)
					.frame(width: 44, height: 44)
					.overlay(RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.input, lineWidth: 1))
					.contentShape(.rect)
			}
			.accessibilityLabel("More actions")
		}
		.disabled(responder.pending != nil)
	}
}

// MARK: - Row line

extension AlertIncident {
	/// The one line a list row adds about who has an open incident, or nil
	/// when there is nothing to say (nobody paged, nobody acknowledged).
	func responseLine(pagedViewer: Bool, viewerUserId: String?) -> String? {
		switch responseState {
		case .unacknowledged(let next):
			guard let next else { return pagedViewer ? "Unacknowledged" : nil }
			return "Unacknowledged · \(next.headline(viewerUserId: viewerUserId).lowercasedFirst) at \(Format.clock(next.at))"
		case .acknowledged(let acknowledgement):
			return acknowledgement.summary(viewerUserId: viewerUserId)
		case .resolved:
			guard let waited = timeToAcknowledge else { return nil }
			return "Acknowledged in \(IncidentWording.span(waited))"
		}
	}
}

extension String {
	/// "Pages Priya Shah" mid-sentence: "pages Priya Shah".
	fileprivate var lowercasedFirst: String {
		prefix(1).lowercased() + dropFirst()
	}
}
