import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IssuesListModel {
	private(set) var loader: ScreenLoader<[ErrorIssue]>!
	private(set) var isLoadingMore = false

	/// Unresolved by default, as the triage design opens on it.
	var query = IssueQuery(actionableOnly: true, sort: .lastSeen) {
		didSet {
			// The server rejects a cursor carried across a sort change
			// (`cursor_sort_mismatch`), so any filter edit restarts pagination.
			guard query != oldValue else { return }
			Telemetry.track(
				Telemetry.Event.issuesFiltered,
				[
					"sort": query.sort.rawValue,
					"actionable_only": String(query.actionableOnly),
					"severity": query.severity?.rawValue ?? "any",
					"state": query.workflowState?.rawValue ?? "any",
				]
			)
			Task { await loader.load(.replace) }
		}
	}

	private var nextCursor: String?
	private var hasMore = false

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.loader = ScreenLoader(session: session, screen: Screen.issues, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetchFirstPage() }
	}

	var state: LoadState<[ErrorIssue]> { loader.state }

	private func fetchFirstPage() async throws -> [ErrorIssue] {
		let page = try await api.issues(query: query, window: nil, limit: 20, cursor: nil)
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		return page.items
	}

	/// Append the next page. Silent by design: a pagination failure must not
	/// throw away the rows already on screen, and a page that arrives after a
	/// refresh or filter change replaced the list is dropped rather than
	/// appended to rows it was never a continuation of.
	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, state.value != nil else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		let generation = loader.generation

		guard let page = try? await api.issues(query: query, window: nil, limit: 20, cursor: cursor) else {
			if generation == loader.generation { hasMore = false }
			return
		}
		guard generation == loader.generation else { return }
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		loader.update(ifGeneration: generation) { $0 + page.items }
	}

	var canLoadMore: Bool { hasMore }

	/// The card's section label, named for the active chips.
	var listTitle: String {
		switch (query.actionableOnly, query.workflowState == .regressed) {
		case (_, true): "Regressed issues"
		case (true, false): "Unresolved issues"
		case (false, false): "All issues"
		}
	}

	/// Set when a row action fails; the list shows it as an alert.
	var actionError: String?

	/// A row action from the list, swapped in place with the issue the server
	/// returns, so the row's badges change without refetching the page.
	func perform(_ action: IssueAction, on id: String) async {
		let generation = loader.generation
		do {
			let updated: ErrorIssue =
				switch action {
				case .resolve: try await api.transitionIssue(id: id, to: .done, note: nil)
				case .ignore: try await api.transitionIssue(id: id, to: .wontfix, note: nil)
				case .reopen: try await api.transitionIssue(id: id, to: .todo, note: nil)
				case .claim: try await api.claimIssue(id: id)
				case .release: try await api.releaseIssue(id: id)
				case .severity(let severity): try await api.setIssueSeverity(id: id, severity: severity)
				}
			loader.update(ifGeneration: generation) { issues in
				issues.map { $0.id == id ? updated : $0 }
			}
		} catch is CancellationError {
		} catch let error as MapleAPIError {
			actionError = error.message
		} catch {
			actionError = "Couldn't update the issue. Try again."
		}
	}
}

/// The Errors segment of the triage hub. Content only: the hub owns the
/// `NavigationStack`, the header and the destinations; this view contributes
/// its filter chips and the issues card.
struct IssuesListContent: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: IssuesListModel
	@State private var openSwipeID: String?

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: "No issues",
			emptyMessage: model.query.workflowState == .regressed
				? "No fix has failed to hold."
				: model.query.actionableOnly
				? "Nothing needs attention right now."
				: "No error issues match these filters.",
			skeletonRowHeight: 84,
			header: {
				FilterChipBar {
					FilterChip(title: "Unresolved", isOn: model.query.actionableOnly) {
						model.query.actionableOnly.toggle()
					}
					FilterChip(title: "Regressed", isOn: model.query.workflowState == .regressed) {
						model.query.workflowState = model.query.workflowState == .regressed ? nil : .regressed
					}
				}
			}
		) { issues in
			ListCard(
				title: model.listTitle,
				count: "\(issues.count)\(model.canLoadMore ? "+" : "")",
				trailing: "Last seen"
			) {
				ForEach(issues, id: \.id) { issue in
					row(issue)
					if issue.id != issues.last?.id || model.canLoadMore { Hairline() }
				}
				if model.canLoadMore {
					// Trigger on the appearance of the trailing row rather than
					// on a scroll offset, so row heights never matter.
					SkeletonList(rowHeight: 84, rows: 1)
						.task { await model.loadMore() }
				}
			}
		}
		.task {
			await model.loader.loadIfNeeded()
		}
		.alert(
			"Couldn't update",
			isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(model.actionError ?? "")
		}
		.mapleScreen(Screen.issues)
	}

	private func row(_ issue: ErrorIssue) -> some View {
		SwipeActionRow(id: issue.id, openID: $openSwipeID, actions: swipeActions(for: issue)) {
			NavigationLink(value: Route.issue(id: issue.id)) {
				IssueListRow(issue: issue)
			}
			.buttonStyle(RowButtonStyle())
		}
		.contextMenu {
			// Offered by state, as the detail screen's action bar does.
			if issue.workflowState.isClosed {
				Button("Reopen", systemImage: "arrow.uturn.backward") {
					Task { await model.perform(.reopen, on: issue.id) }
				}
			} else {
				Button("Resolve", systemImage: "checkmark") {
					Task { await model.perform(.resolve, on: issue.id) }
				}
				Button(issue.claimedAt == nil ? "Claim" : "Release", systemImage: "person") {
					Task { await model.perform(issue.claimedAt == nil ? .claim : .release, on: issue.id) }
				}
				Button("Ignore", systemImage: "eye.slash") {
					Task { await model.perform(.ignore, on: issue.id) }
				}
			}
		}
	}

	/// Assign (claim, or release when already claimed) and Resolve, or Reopen
	/// once the issue is closed: the same calls the long-press menu makes.
	private func swipeActions(for issue: ErrorIssue) -> [SwipeAction] {
		let claimed = issue.claimedAt != nil
		let assign = SwipeAction(
			id: "assign", title: claimed ? "Release" : "Assign", icon: .user,
			fill: Token.muted, tint: Token.foreground
		) {
			Task { await model.perform(claimed ? .release : .claim, on: issue.id) }
		}
		let close = issue.workflowState.isClosed
			? SwipeAction(id: "reopen", title: "Reopen", icon: .circleCheck, fill: Token.muted, tint: Token.foreground) {
				Task { await model.perform(.reopen, on: issue.id) }
			}
			: SwipeAction(id: "resolve", title: "Resolve", icon: .circleCheck, fill: Token.success, tint: Token.primaryForeground) {
				Task { await model.perform(.resolve, on: issue.id) }
			}
		return [assign, close]
	}
}

/// The issue row, following `issue-row.tsx`: severity chip, then the exception
/// type with its message trailing on the same line in muted text, then service,
/// count, and a terse relative time.
struct IssueRow: View {
	let issue: ErrorIssue
	let showsService: Bool

	/// See `ErrorIssue.displayTitle` — shared with the Home Screen widget, so
	/// the same issue names itself the same way on both surfaces.
	private var title: String { issue.displayTitle }
	private var subtitle: String? { issue.displaySubtitle }

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			// Fixed-width severity lane, mirroring the web's `w-[60px]`. Without
			// it the title starts at a different x on every row, because a badge
			// and an em dash are different widths.
			SeverityBadge(severity: issue.severity)
				.frame(width: 56, alignment: .leading)

			VStack(alignment: .leading, spacing: 4) {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(title)
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					Spacer(minLength: 4)
					Text(Format.lastSeen(issue.lastSeenAt))
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.layoutPriority(1)
				}

				if let subtitle {
					Text(subtitle)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(2)
						.fixedSize(horizontal: false, vertical: true)
				}

				// One line, truncating. Wrapping metadata destroys the row rhythm
				// that makes a dense list scannable.
				HStack(spacing: 10) {
					if showsService {
						HStack(spacing: 5) {
							ServiceDot(serviceName: issue.serviceName, size: 6)
							Text(issue.serviceName)
								.font(Typo.tiny)
								.foregroundStyle(Token.mutedForeground)
						}
						.fixedSize()
					}

					// The web carries this as a bare number with a tooltip; a
					// phone has no hover, so the unit has to be on the row or
					// the count reads as an orphan digit.
					Text("\(Format.count(issue.occurrenceCount)) events")
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.fixedSize()

					if issue.hasOpenIncident {
						HStack(spacing: 4) {
							Circle()
								.fill(Token.destructive)
								.frame(width: 5, height: 5)
							Text("Incident")
								.font(Typo.tinyMedium)
								.foregroundStyle(Token.destructive)
						}
						.fixedSize()
					}

					Spacer(minLength: 0)
				}
				.lineLimit(1)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 56)
		.contentShape(.rect)
	}
}
