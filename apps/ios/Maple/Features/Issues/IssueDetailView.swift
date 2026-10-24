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
		.toolbar {
			ToolbarItemGroup(placement: .topBarTrailing) {
				OpenOnWebButton(url: MapleWeb.issue(issueID))
				if let model, let issue = model.state.value {
					IssueMoreMenu(issue: issue) { action in
						Task { await model.perform(action) }
					}
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
			let model =
				if let model, model.generation == session.dataGeneration { model } else {
					IssueDetailModel(issueID: issueID, api: session.api, session: session)
				}
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

/// The nav bar's `...` menu: severity, and Ignore or Reopen by state.
private struct IssueMoreMenu: View {
	let issue: ErrorIssueDetail
	let perform: (IssueAction) -> Void

	var body: some View {
		Menu {
			Menu("Severity") {
				ForEach([IssueSeverity.critical, .high, .medium, .low], id: \.self) { severity in
					Button(severity.label) { perform(.severity(severity)) }
				}
				Divider()
				Button("Clear") { perform(.severity(nil)) }
			}
			if issue.workflowState.isClosed {
				Button("Reopen", systemImage: "arrow.uturn.backward") { perform(.reopen) }
			} else {
				Button("Ignore", systemImage: "eye.slash") { perform(.ignore) }
			}
		} label: {
			PixelIcon.dotsVertical.image
				.resizable()
				.frame(width: 16, height: 16)
				.foregroundStyle(Token.foreground)
		}
		.accessibilityLabel("More actions")
	}
}
