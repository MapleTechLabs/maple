import Charts
import MapleAPI
import SwiftUI

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
		case "requests_per_sec": Format.count(value) + " rps"
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
		guard pct.isFinite else { return Format.placeholder }
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


extension WidgetFormat {
	/// The short unit a chart card shows beside its title: `ms`, `rps`, `%`.
	static func unitLabel(_ unit: String?) -> String? {
		switch unit {
		case "percent", "percent_100": "%"
		case "duration_ms", "duration_us", "duration_s", "duration_ns": "ms"
		case "requests_per_sec": "rps"
		case "bytes": "bytes"
		default: nil
		}
	}
}

/// One non-stat widget: a hairline card with its title, unless it is a table,
/// which is already a card.
struct DashboardWidgetCard: View {
	let widget: MobileWidget
	let result: WidgetResult?

	var body: some View {
		if widget.kind == .table, case .ready(let data) = result, !data.rows.isEmpty {
			DashboardTable(title: widget.title, rows: data.rows, unit: widget.unit)
		} else {
			VStack(alignment: .leading, spacing: 12) {
				header
				content
			}
			.hairlineCard(padding: 12)
		}
	}

	@ViewBuilder private var header: some View {
		let trailing = trailingLabel
		if !widget.title.isEmpty || trailing != nil {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(widget.title)
					.font(Typo.small)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
					.accessibilityAddTraits(.isHeader)
				Spacer(minLength: 8)
				if let trailing {
					Text(trailing)
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
				}
			}
		}
	}

	/// The unit for a chart, the sum for a bar list.
	private var trailingLabel: String? {
		switch widget.kind {
		case .chart: return WidgetFormat.unitLabel(widget.unit)
		case .breakdown:
			guard case .ready(let data) = result else { return nil }
			let items = DashboardBarList.items(data.rows)
			guard !items.isEmpty else { return nil }
			return WidgetFormat.value(items.reduce(0) { $0 + $1.value }, unit: widget.unit) + " total"
		default: return nil
		}
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
				case .chart: DashboardLineChart(rows: data.rows, unit: widget.unit)
				case .breakdown: DashboardBarList(rows: data.rows, unit: widget.unit)
				default: Muted(text: "No rows.")
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

private struct DashboardLineChart: View {
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
		// Each series' latest value, for the legend.
		let latest = Dictionary(grouping: points, by: \.series).compactMapValues { $0.max { $0.date < $1.date }?.value }
		VStack(alignment: .leading, spacing: 12) {
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
					AxisValueLabel(format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute())
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
				}
			}
			.chartYAxis {
				AxisMarks(values: .automatic(desiredCount: 4)) { _ in
					AxisGridLine().foregroundStyle(Token.border)
				}
			}
			.frame(height: 150)
			.accessibilityLabel("Chart of \(series.joined(separator: ", "))")

			WrappingLegendLayout(spacing: 16, lineSpacing: 6) {
				ForEach(series.prefix(8), id: \.self) { name in
					HStack(spacing: 6) {
						RoundedRectangle(cornerRadius: 2).fill(seriesTint(name)).frame(width: 8, height: 8)
						Text(name)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
						if let value = latest[name] {
							Text(WidgetFormat.value(value, unit: unit))
								.tabularNumbers()
								.foregroundStyle(Token.foreground)
						}
					}
					.font(Typo.tiny)
					.accessibilityElement(children: .combine)
				}
			}
		}
	}
}

/// `hbar` and `pie` at phone width: label and value over a proportional bar.
private struct DashboardBarList: View {
	let rows: [[String: JSONValue]]
	let unit: String?

	struct Item: Hashable {
		let name: String
		let value: Double
	}

	static func items(_ rows: [[String: JSONValue]]) -> [Item] {
		rows.compactMap { row in
			guard let name = row["name"]?.string else { return nil }
			return Item(name: name, value: value(of: row))
		}
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
		let items = Self.items(rows)
		let peak = max(items.map(\.value).max() ?? 1, 1)
		VStack(spacing: 10) {
			ForEach(items.prefix(8), id: \.self) { item in
				VStack(alignment: .leading, spacing: 4) {
					HStack(spacing: 8) {
						Text(item.name)
							.foregroundStyle(Token.foreground)
							.lineLimit(1)
						Spacer(minLength: 8)
						Text(WidgetFormat.value(item.value, unit: unit))
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					}
					.font(Typo.small)
					GeometryReader { proxy in
						ZStack(alignment: .leading) {
							RoundedRectangle(cornerRadius: 2).fill(Token.muted)
							RoundedRectangle(cornerRadius: 2)
								.fill(Token.chartError)
								.frame(width: max(proxy.size.width * item.value / peak, 3))
						}
					}
					.frame(height: 6)
				}
				.accessibilityElement(children: .combine)
			}
		}
	}
}

/// A table or list widget as a `TableCard`: the first text column names the
/// row; percentile columns take the chart palette.
private struct DashboardTable: View {
	let title: String
	let rows: [[String: JSONValue]]
	let unit: String?

	private static let percentiles = ["p50", "p95", "p99"]

	private var columns: (label: String?, numbers: [String]) {
		guard let first = rows.first else { return (nil, []) }
		let label = first.keys.sorted().first { key in
			if case .string = first[key] { return key != "bucket" }
			return false
		}
		let numeric = first.keys.filter { key in
			if case .number = first[key] { return true }
			return false
		}
		let percentiles = Self.percentiles.filter(numeric.contains)
		if !percentiles.isEmpty { return (label, percentiles) }
		let preferred = ["value", "count", "errorRate"]
		let ordered = preferred.filter(numeric.contains) + numeric.filter { !preferred.contains($0) }.sorted()
		return (label, Array(ordered.prefix(2)))
	}

	var body: some View {
		let columns = columns
		TableCard(columns: [columns.label ?? "Row"] + columns.numbers, title: title.isEmpty ? nil : title) {
			ForEach(Array(rows.prefix(10).enumerated()), id: \.offset) { _, row in
				TableRow {
					Text(columns.label.flatMap { row[$0]?.string } ?? Format.placeholder)
						.font(Typo.small)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
				} trailing: {
					ForEach(columns.numbers, id: \.self) { key in
						TableCell(text: row[key]?.number.map { format($0, key: key) } ?? Format.placeholder, tint: tint(key))
					}
				}
			}
		}
	}

	private func tint(_ key: String) -> Color {
		switch key {
		case "p50": Token.chartP50
		case "p95": Token.chartP95
		case "p99": Token.chartP99
		default: Token.foreground
		}
	}

	private func format(_ value: Double, key: String) -> String {
		if Self.percentiles.contains(key) { return Format.latency(value) }
		if key == "count" { return Format.count(value) }
		return WidgetFormat.value(value, unit: unit)
	}
}
