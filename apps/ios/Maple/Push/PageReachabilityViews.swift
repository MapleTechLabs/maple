import MapleAPI
import SwiftUI

/// The outlined button for an action that is not the screen's one amber one.
struct OutlineButton: View {
	let title: String
	/// The longest title this button will carry, so it keeps one width as the title changes.
	var widestTitle: String? = nil
	var isDisabled = false
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			ZStack {
				if let widestTitle { Text(widestTitle).hidden() }
				Text(title)
			}
			.font(Typo.smallMedium)
			.foregroundStyle(Token.foreground)
			.lineLimit(1)
			.padding(.horizontal, 14)
			.frame(height: 36)
			.overlay(RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.input, lineWidth: 1))
			.opacity(isDisabled ? 0.5 : 1)
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.disabled(isDisabled)
		.accessibilityLabel(title)
	}
}

/// What stands between a page and this phone, and the one button that fixes it.
struct PageReachabilityProblemView: View {
	let problem: PageReachability.Problem

	@Environment(SessionController.self) private var session
	@State private var isFixing = false
	private let push = PushRegistrar.shared

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			VStack(alignment: .leading, spacing: 4) {
				Text(problem.title)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.fixedSize(horizontal: false, vertical: true)
				Text(problem.detail)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
			.accessibilityElement(children: .combine)
			OutlineButton(title: problem.fixTitle, isDisabled: isFixing, action: fix)
		}
	}

	private func fix() {
		guard !isFixing else { return }
		isFixing = true
		let api = session.api
		let orgId = session.currentOrganizationId
		Task {
			await push.perform(problem.fix, api: api, orgId: orgId)
			isFixing = false
		}
	}
}

/// The warning on Overview and On call: a page would not reach this phone.
/// Drawn only for someone on call now or within a week of a shift, and only
/// while there is a problem. The tab root re-reads the settings on every return
/// to the foreground, which is when a fix made in the Settings app shows here.
struct PageReachabilityCard: View {
	let overview: OnCallOverview
	var now = Date()

	@Environment(SessionController.self) private var session
	private let push = PushRegistrar.shared

	private var problem: PageReachability.Problem? {
		push.pageReachability(orgId: session.currentOrganizationId)?
			.warning(for: overview.viewerState(now: now), now: now)
	}

	var body: some View {
		if let problem {
			PageReachabilityProblemView(problem: problem)
				.padding(.leading, 14)
				.padding(.trailing, 12)
				.padding(.vertical, 12)
				.severityRail(Token.severityWarn)
				.hairlineCard()
		}
	}
}

/// "Send a test page" and the one line saying what came of it.
struct TestPageControl: View {
	/// Where the button was pressed, for the span.
	enum Surface: String {
		case settings
		case onCall = "on_call"
	}

	let surface: Surface

	@Environment(SessionController.self) private var session
	@State private var isSending = false
	@State private var result: String?

	private static let title = "Send a test page"

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			OutlineButton(
				title: isSending ? "Sending…" : Self.title,
				widestTitle: Self.title,
				isDisabled: isSending,
				action: send
			)
			if let result {
				Text(result)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func send() {
		guard !isSending else { return }
		isSending = true
		result = nil
		let api = session.api
		// Not tied to the view: a send under way finishes, and its span closes.
		Task {
			let sent = await Self.send(api: api, surface: surface)
			let line = sent?.message ?? TestPageResult.failureMessage
			result = line
			isSending = false
			AccessibilityNotification.Announcement(line).post()
			// The warning card and its Try again follow from what the server now holds.
			if sent?.mayHaveLostThisPhone == true { await PushRegistrar.shared.reconcileRegistration(api: api) }
		}
	}

	/// The request with its span and event. Nil is a request that never answered:
	/// a failure is a result like the others, never a state to wait in.
	private static func send(api: any MapleAPI, surface: Surface) async -> TestPageResult? {
		let result = await Telemetry.span(
			Telemetry.Name.testPage,
			attributes: [Telemetry.Key.testPageSurface: .string(surface.rawValue)]
		) { span -> TestPageResult? in
			do {
				let result = try await api.sendTestPage()
				span?.setAttribute(Telemetry.Key.testPageOutcome, result.outcome.rawValue)
				span?.setAttribute(Telemetry.Key.testPageSentCount, result.sent)
				return result
			} catch {
				let apiError = error as? MapleAPIError
				span?.setAttribute(Telemetry.Key.testPageOutcome, TestPageResult.Outcome.failed.rawValue)
				span?.setAttribute(Telemetry.Key.errorType, apiError?.telemetryType ?? "transport")
				span?.setStatus(.error(apiError?.message ?? error.localizedDescription))
				return nil
			}
		}
		let outcome = result?.outcome ?? .failed
		Telemetry.track(Telemetry.Event.testPageSent, ["outcome": outcome.rawValue, "surface": surface.rawValue])
		return result
	}
}
