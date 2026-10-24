import MapleAPI
import SwiftUI

// MARK: - List

@MainActor
@Observable
final class DashboardsListModel {
	private(set) var loader: ScreenLoader<[DashboardSummary]>!
	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		loader = ScreenLoader(session: session, screen: Screen.dashboards, isEmpty: { $0.isEmpty }) { [unowned self] in
			try await self.api.dashboards(limit: 50, cursor: nil).items
		}
	}
}

/// `GET /v2/dashboards`, the web Dashboards page's list. Read-only on the phone.
struct DashboardsListView: View {
	@Environment(SessionController.self) private var session
	@State private var model: DashboardsListModel?

	var body: some View {
		LoadableView(
			loader: model?.loader,
			emptyTitle: "No dashboards",
			emptyMessage: "Dashboards built on the web appear here.",
			skeletonRowHeight: 60
		) { dashboards in
			LazyVStack(spacing: 0) {
				ForEach(dashboards) { dashboard in
					NavigationLink(value: Route.dashboard(id: dashboard.id, name: dashboard.name)) {
						DashboardRow(dashboard: dashboard)
					}
					.buttonStyle(RowButtonStyle())
					if dashboard.id != dashboards.last?.id { Hairline() }
				}
			}
			.dashboardCard()
			.padding(16)
		}
		.mapleScreen(Screen.dashboards)
		.task {
			if model == nil { model = DashboardsListModel(api: session.api, session: session) }
			await model?.loader.loadIfNeeded()
		}
	}
}

private struct DashboardRow: View {
	let dashboard: DashboardSummary

	var body: some View {
		HStack(spacing: 12) {
			VStack(alignment: .leading, spacing: 4) {
				Text(dashboard.name)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text(subtitle)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
			Spacer(minLength: 8)
			PixelIcon.chevronRight.image
				.resizable()
				.frame(width: 12, height: 12)
				.foregroundStyle(Token.mutedForeground)
				.accessibilityHidden(true)
		}
		.padding(.horizontal, 12)
		.frame(minHeight: 60)
		.contentShape(.rect)
	}

	private var subtitle: String {
		let widgets = dashboard.widgetCount == 1 ? "1 widget" : "\(dashboard.widgetCount) widgets"
		return [widgets, dashboard.description, "updated \(Format.lastSeen(dashboard.updatedAt))"]
			.compactMap { $0 }
			.filter { !$0.isEmpty }
			.joined(separator: " · ")
	}
}

extension View {
	/// The hairline card every dashboard surface sits in.
	func dashboardCard(padding: CGFloat = 0) -> some View {
		self
			.padding(padding)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
			.clipShape(.rect(cornerRadius: Token.Radius.lg))
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.lg)
					.stroke(Token.border, lineWidth: Token.hairline)
			)
	}
}

// MARK: - Detail

struct DashboardBoard: Sendable {
	var dashboard: MobileDashboard
	/// Resolved per widget id; missing until that widget's batch lands.
	var data: [String: WidgetResult] = [:]
}

enum WidgetResult: Sendable, Hashable {
	case ready(WidgetData)
	case failed(WidgetOutcome.Failure, String?)
}

@MainActor
@Observable
final class DashboardDetailModel {
	var window: TimeWindow = .last24Hours
	private(set) var loader: ScreenLoader<DashboardBoard>!
	let dashboardID: String
	let generation: Int
	private let api: any MapleAPI
	private var windowSeeded = false

	func select(_ window: TimeWindow) {
		// A pick wins over the board's saved range, even before the first load lands.
		windowSeeded = true
		guard window != self.window else { return }
		self.window = window
		Task { await loader.load(.replace) }
	}

	init(dashboardID: String, api: any MapleAPI, session: SessionController) {
		self.dashboardID = dashboardID
		self.api = api
		self.generation = session.dataGeneration
		loader = ScreenLoader(session: session, screen: Screen.dashboardDetail) { [unowned self] in
			try await self.fetch()
		}
	}

	/// The board, then its widgets four at a time through
	/// `POST /v2/dashboards/{id}/widget_data`: the server builds every query from
	/// the stored document, exactly as it does for the web board.
	private func fetch() async throws -> DashboardBoard {
		let dashboard = try await api.dashboard(id: dashboardID)
		if !windowSeeded, let saved = TimeWindow(dashboardRange: dashboard.relativeRange) {
			window = saved
		}
		windowSeeded = true
		let resolved = window.resolve()
		let batches = stride(from: 0, to: dashboard.widgets.count, by: 4).map {
			Array(dashboard.widgets[$0..<min($0 + 4, dashboard.widgets.count)])
		}
		let api = self.api
		let id = dashboardID
		// Throwing, so an expired session or a 5xx reaches `session.perform` and the
		// screen's error state; per-widget failures still ride inside a 200.
		let outcomes = try await withThrowingTaskGroup(of: [WidgetOutcome].self, returning: [WidgetOutcome].self) { group in
			for batch in batches where batch.contains(where: { $0.kind != .markdown && $0.kind != .unsupported }) {
				group.addTask {
					try await api.dashboardWidgetData(
						dashboardId: id, widgetIds: batch.map(\.id), window: resolved, maxDataPoints: 48
					)
				}
			}
			var all: [WidgetOutcome] = []
			for try await batch in group { all += batch }
			return all
		}
		var board = DashboardBoard(dashboard: dashboard)
		let transforms = Dictionary(dashboard.widgets.map { ($0.id, $0.transform) }, uniquingKeysWith: { a, _ in a })
		for outcome in outcomes {
			if let failure = outcome.failure {
				board.data[outcome.widgetId] = .failed(failure, outcome.message)
			} else {
				board.data[outcome.widgetId] = .ready(
					WidgetData(response: outcome.response ?? .null, transform: transforms[outcome.widgetId] ?? nil)
				)
			}
		}
		return board
	}
}

extension TimeWindow {
	/// A dashboard's saved relative range, when the phone has a matching window.
	init?(dashboardRange: String?) {
		switch dashboardRange {
		case "1h": self = .lastHour
		case "6h": self = .last6Hours
		case "24h", "1d": self = .last24Hours
		case "7d": self = .last7Days
		default: return nil
		}
	}
}


struct DashboardDetailView: View {
	let dashboardID: String
	let name: String

	@Environment(SessionController.self) private var session
	@Environment(\.openURL) private var openURL
	@State private var model: DashboardDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Dashboard not found",
				emptyMessage: "It may have been deleted on the web.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { board in
				DashboardContent(
					board: board,
					window: model?.window ?? .last24Hours,
					// Reloads only on a user pick; seeding the board's saved range must not refetch it.
					select: { model?.select($0) }
				)
			}
		}
		.navigationTitle("")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let url = MapleWeb.dashboard(dashboardID) {
				ToolbarItem(placement: .topBarTrailing) {
					Menu {
						Button("Open on web", systemImage: "safari") { openURL(url) }
					} label: {
						PixelIcon.dotsVertical.image
							.resizable()
							.frame(width: 16, height: 16)
							.foregroundStyle(Token.mutedForeground)
					}
					.accessibilityLabel("More")
				}
			}
		}
		.mapleScreen(Screen.dashboardDetail)
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : DashboardDetailModel(dashboardID: dashboardID, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
		}
	}
}

private enum BoardBlock: Identifiable {
	case stats([MobileWidget])
	case widget(MobileWidget)

	var id: String {
		switch self {
		case .stats(let widgets): "stats-" + (widgets.first?.id ?? "")
		case .widget(let widget): widget.id
		}
	}

	static func blocks(_ widgets: [MobileWidget]) -> [BoardBlock] {
		var blocks: [BoardBlock] = []
		var run: [MobileWidget] = []
		for widget in widgets {
			if widget.kind == .stat {
				run.append(widget)
				continue
			}
			if !run.isEmpty { blocks.append(.stats(run)); run = [] }
			blocks.append(.widget(widget))
		}
		if !run.isEmpty { blocks.append(.stats(run)) }
		return blocks
	}
}


private struct DashboardContent: View {
	let board: DashboardBoard
	let window: TimeWindow
	let select: (TimeWindow) -> Void

	private var widgetCount: String {
		board.dashboard.widgets.count == 1 ? "1 widget" : "\(board.dashboard.widgets.count) widgets"
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			VStack(alignment: .leading, spacing: 8) {
				Text(board.dashboard.name)
					.font(Typo.pageTitle)
					.tracking(-0.6)
					.foregroundStyle(Token.foreground)
					.accessibilityAddTraits(.isHeader)
				if let description = board.dashboard.description, !description.isEmpty {
					Text(description)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
				}
				HStack(spacing: 8) {
					Text(widgetCount)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
					Spacer(minLength: 8)
					DashboardWindowPill(window: window, select: select)
				}
			}
			.padding(.bottom, 12)

			ForEach(BoardBlock.blocks(board.dashboard.widgets)) { block in
				switch block {
				case .stats(let widgets):
					StatGrid(columns: 2) {
						ForEach(widgets) { widget in
							StatTile(
								label: widget.title,
								value: board.data[widget.id].flatMap(\.number).map { WidgetFormat.stat($0, widget: widget) } ?? "—"
							)
						}
					}
				case .widget(let widget):
					DashboardWidgetCard(widget: widget, result: board.data[widget.id])
				}
			}

			Text("Read-only on iPhone · Edit on web")
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.frame(maxWidth: .infinity)
				.padding(.top, 16)
		}
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.padding(.bottom, 24)
	}
}

/// `Last 24h ⌄`: the board's time range as a bordered pill.
private struct DashboardWindowPill: View {
	let window: TimeWindow
	let select: (TimeWindow) -> Void

	var body: some View {
		Menu {
			Picker("Time range", selection: Binding(get: { window }, set: select)) {
				ForEach(TimeWindow.allCases) { option in
					Text(option.title).tag(option)
				}
			}
		} label: {
			HStack(spacing: 6) {
				Text(Self.label(window))
					.font(Typo.small)
					.foregroundStyle(Token.foreground)
				PixelIcon.chevronDown.image
					.resizable()
					.frame(width: 12, height: 12)
					.foregroundStyle(Token.mutedForeground)
			}
			.padding(.horizontal, 12)
			.frame(height: 32)
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.md)
					.stroke(Token.input, lineWidth: Token.hairline)
			)
			.contentShape(.rect)
		}
		.accessibilityLabel("Time range, \(window.title)")
	}

	private static func label(_ window: TimeWindow) -> String {
		switch window {
		case .lastHour: "Last 1h"
		case .last6Hours: "Last 6h"
		case .last24Hours: "Last 24h"
		case .last7Days: "Last 7d"
		}
	}
}
