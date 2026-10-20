import Charts
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
					Hairline()
				}
			}
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
			Image(systemName: "square.grid.2x2")
				.font(.system(size: 13))
				.foregroundStyle(Token.mutedForeground)
				.frame(width: 20)
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
			Image(systemName: "chevron.right")
				.font(.system(size: 11, weight: .semibold))
				.foregroundStyle(Token.mutedForeground.opacity(0.5))
		}
		.padding(.horizontal, 16)
		.frame(minHeight: 60)
		.contentShape(.rect)
	}

	private var subtitle: String {
		let widgets = dashboard.widgetCount == 1 ? "1 widget" : "\(dashboard.widgetCount) widgets"
		return [dashboard.description, widgets, "updated \(Format.lastSeen(dashboard.updatedAt))"]
			.compactMap { $0 }
			.joined(separator: " · ")
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
				DashboardContent(board: board)
			}
		}
		.navigationTitle("Dashboard")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let model {
				@Bindable var model = model
				ToolbarItem(placement: .topBarTrailing) {
					// Reloads only on a user pick; seeding the board's saved range must not refetch it.
					TimeWindowMenu(window: Binding(get: { model.window }, set: { model.select($0) }))
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

/// Runs of stat tiles share a two-up grid; everything else is full width.
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

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			VStack(alignment: .leading, spacing: 6) {
				Text(board.dashboard.name)
					.font(Typo.title)
					.foregroundStyle(Token.foreground)
				if let description = board.dashboard.description, !description.isEmpty {
					Text(description)
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
				}
				Text("Read-only on iPhone. Edit on the web.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground.opacity(0.7))
			}

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
					WidgetCard(widget: widget, result: board.data[widget.id])
				}
			}
		}
		.padding(16)
	}
}

extension WidgetResult {
	var number: Double? {
		if case .ready(let data) = self { return data.number }
		return nil
	}
}

/// Port of the web's `formatValueByUnit` (`packages/ui/src/lib/format.ts`), so a
/// widget reads the same on the phone as on the board.
enum WidgetFormat {
	static func value(_ value: Double, unit: String?) -> String {
		switch unit {
		case "percent": percent(value * 100)
		case "percent_100": percent(value)
		case "duration_ms": Format.latency(value)
		case "duration_us": Format.latency(value / 1000)
		case "duration_s": Format.latency(value * 1000)
		case "duration_ns": Format.latency(value / 1_000_000)
		case "requests_per_sec": Format.count(value) + "/s"
		case "bytes": bytes(value)
		default: Format.count(value)
		}
	}

	/// `formatStatValue`: the unit formatting wrapped in the widget's prefix and suffix.
	static func stat(_ value: Double, widget: MobileWidget) -> String {
		(widget.prefix ?? "") + Self.value(value, unit: widget.unit) + (widget.suffix ?? "")
	}

	/// `percentText`: one decimal, with more digits only for a tiny nonzero value.
	static func percent(_ pct: Double) -> String {
		guard pct.isFinite else { return "—" }
		let magnitude = abs(pct)
		if magnitude == 0 || magnitude >= 0.05 { return String(format: "%.1f%%", pct) }
		let digits = min(6, Int((-log10(magnitude)).rounded(.up)) + 1)
		let rounded = (pct * pow(10, Double(digits))).rounded() / pow(10, Double(digits))
		if rounded != 0 { return String(format: "%.\(digits)f", rounded).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression) + "%" }
		return pct < 0 ? ">-0.000001%" : "<0.000001%"
	}

	/// `formatStorageBytes`: decimal (1000-based), as saved dashboards expect.
	static func bytes(_ value: Double) -> String {
		guard value.isFinite, value > 0 else { return "0 B" }
		let units = ["B", "KB", "MB", "GB", "TB", "PB"]
		var scaled = value
		var index = 0
		while scaled >= 1000, index < units.count - 1 {
			scaled /= 1000
			index += 1
		}
		return String(format: scaled >= 100 ? "%.0f %@" : "%.1f %@", scaled, units[index])
	}
}

private struct WidgetCard: View {
	let widget: MobileWidget
	let result: WidgetResult?

	var body: some View {
		// A table is already a bordered card; it does not nest inside another.
		if widget.kind == .table, case .ready(let data) = result {
			VStack(alignment: .leading, spacing: 8) {
				title
				WidgetTable(rows: data.rows, unit: widget.unit)
			}
		} else {
			card
		}
	}

	@ViewBuilder private var title: some View {
		if !widget.title.isEmpty {
			Text(widget.title)
				.font(Typo.smallMedium)
				.foregroundStyle(Token.foreground)
		}
	}

	private var card: some View {
		VStack(alignment: .leading, spacing: 12) {
			title
			content
		}
		.padding(12)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
	}

	@ViewBuilder private var content: some View {
		switch widget.kind {
		case .markdown:
			Text(LocalizedStringKey(widget.markdown ?? ""))
				.font(Typo.small)
				.foregroundStyle(Token.foreground)
		case .unsupported:
			Muted(text: "This widget type is on the web only.")
		default:
			switch result {
			case .none:
				RoundedRectangle(cornerRadius: Token.Radius.md).fill(Token.muted.opacity(0.4)).frame(height: 120)
			case .failed(let failure, let message):
				Muted(text: failure == .unsupported ? "This widget type is on the web only." : message ?? "Couldn't load this widget.")
			case .ready(let data):
				switch widget.kind {
				case .chart: WidgetLineChart(rows: data.rows, unit: widget.unit)
				case .breakdown: WidgetBreakdown(rows: data.rows, unit: widget.unit)
				default: WidgetTable(rows: data.rows, unit: widget.unit)
				}
			}
		}
	}

	private struct Muted: View {
		let text: String
		var body: some View {
			Text(text)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
		}
	}
}

/// Series colour: percentiles keep the chart palette, anything else is
/// treated as a service name so it matches its swatch everywhere else.
private func seriesTint(_ key: String) -> Color {
	switch key.lowercased() {
	case "p50": Token.chartP50
	case "p95": Token.chartP95
	case "p99": Token.chartP99
	case "errors", "error_rate", "errorrate": Token.chartError
	default: ServiceColor.color(for: key)
	}
}

private struct WidgetLineChart: View {
	let rows: [[String: JSONValue]]
	let unit: String?

	private struct Point: Identifiable {
		let series: String
		let date: Date
		let value: Double
		var id: String { "\(series)|\(date.timeIntervalSince1970)" }
	}

	private var points: [Point] {
		rows.flatMap { row -> [Point] in
			guard let bucket = row["bucket"]?.string, let date = Self.parseBucket(bucket) else { return [] }
			return row.compactMap { key, value -> Point? in
				guard key != "bucket", let number = value.number else { return nil }
				return Point(series: key, date: date, value: number)
			}
		}
	}

	/// ISO from query widgets, `YYYY-MM-DD HH:MM:SS` UTC from raw SQL ones.
	static func parseBucket(_ text: String) -> Date? {
		if let date = ResolvedTimeWindow.parse(text) { return date }
		return ResolvedTimeWindow.parse(text.replacingOccurrences(of: " ", with: "T") + "Z")
	}

	var body: some View {
		let points = points
		let series = Array(Set(points.map(\.series))).sorted()
		VStack(alignment: .leading, spacing: 8) {
			Chart(points) { point in
				LineMark(
					x: .value("Time", point.date),
					y: .value("Value", point.value),
					series: .value("Series", point.series)
				)
				.foregroundStyle(seriesTint(point.series))
				.lineStyle(StrokeStyle(lineWidth: 1.5))
				.interpolationMethod(.monotone)
			}
			.chartLegend(.hidden)
			.chartXAxis {
				AxisMarks(values: .automatic(desiredCount: 4)) { _ in
					AxisValueLabel(format: .dateTime.hour()).font(Typo.micro)
				}
			}
			.chartYAxis {
				AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
					AxisGridLine().foregroundStyle(Token.border)
					AxisValueLabel {
						if let number = value.as(Double.self) {
							Text(WidgetFormat.value(number, unit: unit)).font(Typo.micro)
						}
					}
				}
			}
			.frame(height: 140)

			if series.count > 1 {
				HStack(spacing: 12) {
					ForEach(series.prefix(5), id: \.self) { name in
						HStack(spacing: 4) {
							RoundedRectangle(cornerRadius: 2).fill(seriesTint(name)).frame(width: 8, height: 8)
							Text(name).font(Typo.micro).foregroundStyle(Token.mutedForeground).lineLimit(1)
						}
					}
				}
			}
		}
	}
}

private struct WidgetBreakdown: View {
	let rows: [[String: JSONValue]]
	let unit: String?

	private var items: [(String, Double)] {
		var result: [(String, Double)] = []
		for row in rows {
			guard let name = row["name"]?.string else { continue }
			result.append((name, Self.value(of: row)))
		}
		return result
	}

	/// `value`, else the first numeric column by name, else 0.
	private static func value(of row: [String: JSONValue]) -> Double {
		if let value = row["value"]?.number { return value }
		for key in row.keys.sorted() where key != "name" {
			if let number = row[key]?.number { return number }
		}
		return 0
	}

	var body: some View {
		let items = items
		let peak = max(items.map(\.1).max() ?? 1, 1)
		VStack(spacing: 10) {
			ForEach(items.prefix(8), id: \.0) { name, value in
				VStack(alignment: .leading, spacing: 4) {
					HStack {
						ServiceDot(serviceName: name)
						Text(name).font(Typo.small).foregroundStyle(Token.foreground).lineLimit(1)
						Spacer()
						Text(WidgetFormat.value(value, unit: unit))
							.font(Typo.small).tabularNumbers().foregroundStyle(Token.mutedForeground)
					}
					GeometryReader { proxy in
						RoundedRectangle(cornerRadius: 1.5)
							.fill(ServiceColor.color(for: name))
							.frame(width: max(proxy.size.width * value / peak, 2))
					}
					.frame(height: 4)
				}
			}
		}
	}
}

private struct WidgetTable: View {
	let rows: [[String: JSONValue]]
	let unit: String?

	/// The first text column names the row; up to two numeric columns follow.
	private var columns: (label: String?, numbers: [String]) {
		guard let first = rows.first else { return (nil, []) }
		let label = first.keys.sorted().first { key in
			if case .string = first[key] { return key != "bucket" }
			return false
		}
		let preferred = ["value", "count", "p95", "p50", "p99", "errorRate"]
		let numeric = first.keys.filter { key in
			if case .number = first[key] { return true }
			return false
		}
		let ordered = preferred.filter(numeric.contains) + numeric.filter { !preferred.contains($0) }.sorted()
		return (label, Array(ordered.prefix(2)))
	}

	var body: some View {
		let columns = columns
		if rows.isEmpty {
			Text("No rows.").font(Typo.small).foregroundStyle(Token.mutedForeground)
		} else {
			TableCard(columns: [columns.label ?? "Row"] + columns.numbers) {
				ForEach(Array(rows.prefix(10).enumerated()), id: \.offset) { _, row in
					TableRow {
						Text(columns.label.flatMap { row[$0]?.string } ?? "—")
							.font(Typo.small)
							.foregroundStyle(Token.foreground)
							.lineLimit(1)
					} trailing: {
						ForEach(columns.numbers, id: \.self) { key in
							TableCell(text: row[key]?.number.map { format($0, key: key) } ?? "—")
						}
					}
				}
			}
		}
	}

	private func format(_ value: Double, key: String) -> String {
		if key.hasPrefix("p"), key.dropFirst().allSatisfy(\.isNumber) { return Format.latency(value) }
		if key == "count" { return Format.count(value) }
		return WidgetFormat.value(value, unit: unit)
	}
}
