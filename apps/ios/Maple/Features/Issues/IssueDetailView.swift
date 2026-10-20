import Charts
import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IssueDetailModel {
	private(set) var loader: ScreenLoader<ErrorIssueDetail>!

	let issueID: String
	let generation: Int
	private let api: any MapleAPI

	init(issueID: String, api: any MapleAPI, session: SessionController) {
		self.issueID = issueID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.issueDetail) { [unowned self] in try await self.api.issue(id: self.issueID) }
	}

	var state: LoadState<ErrorIssueDetail> { loader.state }

	private(set) var pendingAction: IssueAction?
	var actionError: String?

	/// One triage action through the same v2 operation the web issue page uses,
	/// then a refresh so every field reflects what the server now holds.
	func perform(_ action: IssueAction) async {
		guard pendingAction == nil else { return }
		pendingAction = action
		defer { pendingAction = nil }
		do {
			switch action {
			case .resolve: _ = try await api.transitionIssue(id: issueID, to: .done, note: nil)
			case .ignore: _ = try await api.transitionIssue(id: issueID, to: .wontfix, note: nil)
			case .reopen: _ = try await api.transitionIssue(id: issueID, to: .todo, note: nil)
			case .claim: _ = try await api.claimIssue(id: issueID)
			case .release: _ = try await api.releaseIssue(id: issueID)
			case .severity(let severity): _ = try await api.setIssueSeverity(id: issueID, severity: severity)
			}
			await loader.load(.refresh)
		} catch is CancellationError {
		} catch let error as MapleAPIError {
			actionError = error.message
		} catch {
			actionError = "Couldn't update the issue. Try again."
		}
	}
}

extension WorkflowState {
	/// Done, cancelled or won't fix: the states Reopen applies to.
	var isClosed: Bool { [.done, .cancelled, .wontfix].contains(self) }
}

enum IssueAction: Hashable {
	case resolve
	case ignore
	case reopen
	case claim
	case release
	case severity(IssueSeverity?)
}

/// Triage from the phone: resolve, ignore, claim and severity are the v2
/// `transitionErrorIssue` / `claimErrorIssue` / `setErrorIssueSeverity`
/// operations, the same ones the web issue page calls.
///
/// The sections are separate views rather than one long body: the type checker
/// gives up on a body this size ("failed to produce diagnostic for
/// expression"), and the error it emits points at the whole function.
struct IssueDetailView: View {
	let issueID: String

	@Environment(SessionController.self) private var session
	@State private var model: IssueDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Not found",
				emptyMessage: "This issue no longer exists.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { issue in
				IssueDetailContent(issue: issue)
			}
		}
		.safeAreaInset(edge: .bottom) {
			if let model, let issue = model.state.value {
				IssueActionBar(issue: issue, pending: model.pendingAction) { action in
					Task { await model.perform(action) }
				}
			}
		}
		.alert(
			"Couldn't update",
			isPresented: Binding(
				get: { model?.actionError != nil },
				set: { if !$0 { model?.actionError = nil } }
			)
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(model?.actionError ?? "")
		}
		.navigationTitle("Issue")
		.navigationBarTitleDisplayMode(.inline)
		.mapleScreen(Screen.issueDetail)
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : IssueDetailModel(issueID: issueID, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

private struct IssueDetailContent: View {
	let issue: ErrorIssueDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			IssueHeader(issue: issue)
			IssueOccurrences(issue: issue)
			IssueActivity(issue: issue)
			IssueIncidents(incidents: issue.incidents)
			IssueSamples(samples: issue.sampleTraces)
		}
		.padding(.vertical, 16)
	}
}

/// A titled block with the uppercase section label.
private struct Section<Content: View>: View {
	let title: String
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel(title)
				.padding(.horizontal, 16)
			content
		}
	}
}

private struct IssueHeader: View {
	let issue: ErrorIssueDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				SeverityBadge(severity: issue.severity)
				WorkflowBadge(state: issue.workflowState)
				Spacer()
			}

			// Mono, not the display face. Proportional Geist is reserved for page
			// titles and empty states; an exception type is an identifier, and
			// the nav bar already carries this screen's title.
			Text(issue.exceptionType)
				.font(Typo.monoTitle)
				.foregroundStyle(Token.foreground)

			Text(issue.exceptionMessage)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)

			Text(issue.topFrame)
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground.opacity(0.75))
				.lineLimit(2)
				.padding(.horizontal, 10)
				.padding(.vertical, 8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.md))
				.overlay(
					RoundedRectangle(cornerRadius: Token.Radius.md)
						.stroke(Token.border, lineWidth: Token.hairline)
				)
		}
		.padding(.horizontal, 16)
	}
}

private struct IssueOccurrences: View {
	let issue: ErrorIssueDetail

	var body: some View {
		if !issue.timeseries.isEmpty {
			Section(title: "Occurrences") {
				Chart(issue.timeseries, id: \.bucket) { point in
					BarMark(
						x: .value("Time", ResolvedTimeWindow.parse(point.bucket) ?? Date()),
						y: .value("Events", point.count)
					)
					.foregroundStyle(Token.chartError)
				}
				.chartYAxis {
					AxisMarks(position: .leading) { value in
						AxisGridLine().foregroundStyle(Token.border)
						AxisValueLabel().font(Typo.micro).foregroundStyle(Token.mutedForeground)
					}
				}
				.chartXAxis {
					AxisMarks { value in
						AxisValueLabel().font(Typo.micro).foregroundStyle(Token.mutedForeground)
					}
				}
				.frame(height: 132)
				.padding(.horizontal, 16)
			}
		}
	}
}

private struct IssueActivity: View {
	let issue: ErrorIssueDetail

	var body: some View {
		Section(title: "Activity") {
			VStack(spacing: 0) {
				DetailRow(label: "Service") {
					HStack(spacing: 6) {
						ServiceDot(serviceName: issue.serviceName, size: 6)
						Text(issue.serviceName)
					}
				}
				Hairline()
				DetailRow("Events", Format.count(issue.occurrenceCount))
				Hairline()
				DetailRow("First seen", Format.absolute(issue.firstSeenAt))
				Hairline()
				DetailRow("Last seen", Format.lastSeen(issue.lastSeenAt))
				if let assignee {
					Hairline()
					DetailRow("Assigned", assignee)
				}
				if let notes = issue.notes, !notes.isEmpty {
					Hairline()
					DetailRow("Notes", notes)
				}
			}
			.padding(.horizontal, 16)
		}
	}

	private var assignee: String? {
		guard let actor = issue.assignedActor else { return nil }
		return actor.agentName ?? actor.userId ?? actor.id
	}
}

private struct IssueIncidents: View {
	let incidents: [ErrorIncident]

	var body: some View {
		if !incidents.isEmpty {
			Section(title: "Incidents") {
				VStack(spacing: 0) {
					ForEach(incidents, id: \.id) { incident in
						HStack(alignment: .firstTextBaseline) {
							VStack(alignment: .leading, spacing: 3) {
								Text(incident.status == .open ? "Open" : "Resolved")
									.font(Typo.smallMedium)
									.foregroundStyle(
										incident.status == .open ? Token.destructive : Token.mutedForeground
									)
								Text(subtitle(for: incident))
									.font(Typo.tiny)
									.foregroundStyle(Token.mutedForeground)
							}
							Spacer()
							Text(Format.lastSeen(incident.lastTriggeredAt))
								.font(Typo.tiny)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
						}
						.padding(.vertical, 10)
						Hairline()
					}
				}
				.padding(.horizontal, 16)
			}
		}
	}

	private func subtitle(for incident: ErrorIncident) -> String {
		let reason = incident.reason.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
		return "\(reason) · \(Format.count(incident.occurrenceCount)) events"
	}
}

private struct IssueSamples: View {
	let samples: [ErrorIssueSampleTrace]

	var body: some View {
		if !samples.isEmpty {
			Section(title: "Sample traces") {
				VStack(spacing: 0) {
					ForEach(samples, id: \.traceId) { sample in
						NavigationLink(value: Route.trace(id: sample.traceId, spanId: sample.spanId)) {
						HStack(alignment: .firstTextBaseline) {
							Text(sample.traceId)
								.font(Typo.tiny)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
								.truncationMode(.middle)
							Spacer(minLength: 12)
							Text(Format.latency(sample.durationMicros / 1000))
								.font(Typo.tiny)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground)
							Image(systemName: "chevron.right")
								.font(.system(size: 10, weight: .semibold))
								.foregroundStyle(Token.mutedForeground.opacity(0.5))
						}
						.padding(.vertical, 10)
						.contentShape(.rect)
						}
						.buttonStyle(.plain)
						Hairline()
					}
				}
				.padding(.horizontal, 16)
			}
		}
	}
}

/// Pinned above the home indicator. Resolve is the screen's one amber.
private struct IssueActionBar: View {
	let issue: ErrorIssueDetail
	let pending: IssueAction?
	let perform: (IssueAction) -> Void

	private var isClosed: Bool { issue.workflowState.isClosed }

	var body: some View {
		HStack(spacing: 8) {
			if isClosed {
				primary("Reopen", .reopen)
			} else {
				primary("Resolve", .resolve)
			}
			secondary(issue.claimedAt == nil ? "Claim" : "Release", issue.claimedAt == nil ? .claim : .release)
			Menu {
				if !isClosed {
					Button("Ignore") { perform(.ignore) }
				}
				Menu("Severity") {
					ForEach([IssueSeverity.critical, .high, .medium, .low], id: \.self) { severity in
						Button(severity.label) { perform(.severity(severity)) }
					}
					Divider()
					Button("Clear") { perform(.severity(nil)) }
				}
			} label: {
				Image(systemName: "ellipsis")
					.font(.system(size: 14, weight: .semibold))
					.foregroundStyle(Token.foreground)
					.frame(width: 44, height: 40)
					.background(Token.card, in: .rect(cornerRadius: Token.Radius.md))
					.overlay(RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.border, lineWidth: Token.hairline))
			}
			.accessibilityLabel("More actions")
		}
		.disabled(pending != nil)
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.background(.bar)
	}

	private func primary(_ title: String, _ action: IssueAction) -> some View {
		Button { perform(action) } label: {
			label(title, action)
				.foregroundStyle(Token.primaryForeground)
				.background(Token.primary, in: .rect(cornerRadius: Token.Radius.md))
		}
		.buttonStyle(.plain)
	}

	private func secondary(_ title: String, _ action: IssueAction) -> some View {
		Button { perform(action) } label: {
			label(title, action)
				.foregroundStyle(Token.foreground)
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.md))
				.overlay(RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.border, lineWidth: Token.hairline))
		}
		.buttonStyle(.plain)
	}

	private func label(_ title: String, _ action: IssueAction) -> some View {
		Text(pending == action ? "\(title)…" : title)
			.font(Typo.smallMedium)
			.frame(maxWidth: .infinity)
			.frame(height: 40)
	}
}
