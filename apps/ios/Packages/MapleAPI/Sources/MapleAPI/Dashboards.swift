import Foundation
import OpenAPIRuntime

// The phone's read-only view of a dashboard. The generated `Dashboard` carries
// the full editable document; screens only need titles, layout order and each
// widget's transform, so they get this narrower shape.

/// Free-form JSON, for widget payloads whose shape depends on the widget.
public enum JSONValue: Codable, Hashable, Sendable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public init(from decoder: any Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode([JSONValue].self) {
			self = .array(value)
		} else {
			self = .object(try container.decode([String: JSONValue].self))
		}
	}

	public func encode(to encoder: any Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .null: try container.encodeNil()
		case .bool(let value): try container.encode(value)
		case .number(let value): try container.encode(value)
		case .string(let value): try container.encode(value)
		case .array(let value): try container.encode(value)
		case .object(let value): try container.encode(value)
		}
	}

	/// Walks a decoded container directly. Encoding it back to bytes and decoding
	/// again doubled the cost of every widget payload (85 ms on 5,000 rows).
	init(_ container: OpenAPIValueContainer) {
		self.init(any: container.value)
	}

	private init(any value: (any Sendable)?) {
		switch value {
		case .none: self = .null
		case let value as Bool: self = .bool(value)
		case let value as Int: self = .number(Double(value))
		case let value as Double: self = .number(value)
		case let value as String: self = .string(value)
		case let value as [(any Sendable)?]: self = .array(value.map { JSONValue(any: $0) })
		case let value as [String: (any Sendable)?]: self = .object(value.mapValues { JSONValue(any: $0) })
		default: self = .null
		}
	}

	/// Re-reads any generated Codable value as plain JSON.
	static func from<T: Encodable>(_ value: T) throws -> JSONValue {
		try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
	}

	public var object: [String: JSONValue]? {
		if case .object(let value) = self { return value }
		return nil
	}

	public var array: [JSONValue]? {
		if case .array(let value) = self { return value }
		return nil
	}

	/// Numbers, and numeric strings the way JavaScript's `Number()` reads them.
	public var number: Double? {
		switch self {
		case .number(let value): value
		case .string(let value): Double(value)
		case .bool(let value): value ? 1 : 0
		default: nil
		}
	}

	public var string: String? {
		switch self {
		case .string(let value): value
		case .number(let value): value == value.rounded() ? String(Int(value)) : String(value)
		case .bool(let value): String(value)
		default: nil
		}
	}

	public subscript(key: String) -> JSONValue? { object?[key] }
}

public struct DashboardSummary: Identifiable, Hashable, Sendable {
	public let id: String
	public let name: String
	public let description: String?
	public let tags: [String]
	public let widgetCount: Int
	public let updatedAt: String

	init(_ dashboard: Components.Schemas.Dashboard) {
		id = dashboard.id
		name = dashboard.name
		description = dashboard.description
		tags = dashboard.tags ?? []
		widgetCount = dashboard.widgets.count
		updatedAt = dashboard.updatedAt
	}

	public init(id: String, name: String, description: String?, tags: [String], widgetCount: Int, updatedAt: String) {
		self.id = id
		self.name = name
		self.description = description
		self.tags = tags
		self.widgetCount = widgetCount
		self.updatedAt = updatedAt
	}
}

public struct MobileDashboard: Identifiable, Hashable, Sendable {
	public let id: String
	public let name: String
	public let description: String?
	/// The board's saved relative range ("1h", "24h"), when it has one.
	public let relativeRange: String?
	/// In reading order: top to bottom, then left to right, as the web grid lays them out.
	public let widgets: [MobileWidget]

	init(_ dashboard: Components.Schemas.Dashboard) throws {
		id = dashboard.id
		name = dashboard.name
		description = dashboard.description
		relativeRange = dashboard.timeRange.value1?.value
		widgets = try dashboard.widgets
			.map { try MobileWidget(JSONValue.from($0)) }
			.sorted { ($0.y, $0.x) < ($1.y, $1.x) }
	}

	public init(id: String, name: String, description: String?, relativeRange: String?, widgets: [MobileWidget]) {
		self.id = id
		self.name = name
		self.description = description
		self.relativeRange = relativeRange
		self.widgets = widgets
	}
}

public struct MobileWidget: Identifiable, Hashable, Sendable {
	public enum Kind: Hashable, Sendable {
		/// One number: stat and gauge tiles.
		case stat
		/// Rows over time: line, area and bar charts.
		case chart
		/// Name/value rows: horizontal bars and pies.
		case breakdown
		/// Rows with columns: tables and lists.
		case table
		case markdown
		/// Heatmaps, funnels, paths and histograms stay on the web.
		case unsupported
	}

	public let id: String
	public let visualization: String
	public let title: String
	public let unit: String?
	public let prefix: String?
	public let suffix: String?
	public let markdown: String?
	public let transform: WidgetTransform?
	public let x: Double
	public let y: Double
	/// Grid width out of 12; two half-width stat tiles share a phone row.
	public let w: Double

	public var kind: Kind {
		switch visualization {
		case "stat", "gauge": .stat
		case "chart": .chart
		case "hbar", "pie": .breakdown
		case "table", "list": .table
		case "markdown": .markdown
		default: .unsupported
		}
	}

	init(_ json: JSONValue) throws {
		guard let id = json["id"]?.string else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "widget without id")) }
		self.id = id
		visualization = json["visualization"]?.string ?? "chart"
		let display = json["display"]
		title = display?["title"]?.string ?? ""
		unit = display?["unit"]?.string
		prefix = display?["prefix"]?.string
		suffix = display?["suffix"]?.string
		markdown = display?["markdown"]?["content"]?.string
		transform = json["data_source"]?["transform"].map(WidgetTransform.init)
		x = json["layout"]?["x"]?.number ?? 0
		y = json["layout"]?["y"]?.number ?? 0
		w = json["layout"]?["w"]?.number ?? 12
	}

	public init(
		id: String,
		visualization: String,
		title: String,
		unit: String? = nil,
		transform: WidgetTransform? = nil,
		x: Double = 0,
		y: Double = 0,
		w: Double = 12
	) {
		self.id = id
		self.visualization = visualization
		self.title = title
		self.unit = unit
		self.prefix = nil
		self.suffix = nil
		self.markdown = nil
		self.transform = transform
		self.x = x
		self.y = y
		self.w = w
	}
}

/// A widget data source's client-side transform, applied in the web's order.
public struct WidgetTransform: Hashable, Sendable {
	public var hiddenSeries: [String] = []
	public var fieldMap: [String: String] = [:]
	public var sortField: String?
	public var sortDescending = false
	public var limit: Int?
	public var flattenValueField: String?
	public var ratio: (numerator: String, denominators: [String])? {
		get { ratioNumerator.map { ($0, ratioDenominators) } }
		set {
			ratioNumerator = newValue?.numerator
			ratioDenominators = newValue?.denominators ?? []
		}
	}
	public var reduceField: String?
	public var reduceAggregate = "first"

	private var ratioNumerator: String?
	private var ratioDenominators: [String] = []

	public init() {}

	init(_ json: JSONValue) {
		hiddenSeries = json["hide_series"]?["base_names"]?.array?.compactMap(\.string) ?? []
		fieldMap = (json["field_map"]?.object ?? [:]).compactMapValues(\.string)
		sortField = json["sort_by"]?["field"]?.string
		sortDescending = json["sort_by"]?["direction"]?.string == "desc"
		limit = json["limit"]?.number.map { Int($0) }
		flattenValueField = json["flatten_series"]?["value_field"]?.string
		ratioNumerator = json["compute_ratio"]?["numerator_name"]?.string
		ratioDenominators = json["compute_ratio"]?["denominator_names"]?.array?.compactMap(\.string) ?? []
		reduceField = json["reduce_to_value"]?["field"]?.string
		reduceAggregate = json["reduce_to_value"]?["aggregate"]?.string ?? "first"
	}
}

/// What a widget resolved to: rows to draw, or one value.
public enum WidgetData: Hashable, Sendable {
	case rows([[String: JSONValue]])
	case value(JSONValue)

	/// Port of the web's `toReadyData` (`apps/web/src/page/dashboards/kit/widget-data.ts`),
	/// so a stat tile shows the same number on the phone as on the board.
	public init(response: JSONValue, transform: WidgetTransform?) {
		let unwrapped: JSONValue =
			if case .object(let envelope) = response, let inner = envelope["data"] { inner } else { response }
		guard let transform else {
			if let array = unwrapped.array { self = .rows(array.compactMap(\.object)) } else { self = .value(unwrapped) }
			return
		}
		var rows: [[String: JSONValue]]
		if let array = unwrapped.array {
			rows = array.compactMap(\.object)
		} else if let object = unwrapped.object, transform.reduceField != nil {
			rows = [object]
		} else {
			self = .value(unwrapped)
			return
		}
		if !transform.hiddenSeries.isEmpty {
			rows = rows.map { row in
				row.filter { key, _ in key == "bucket" || !Self.isHidden(key, transform.hiddenSeries) }
			}
		}
		if !transform.fieldMap.isEmpty {
			rows = rows.map { row in
				var next = row
				for (target, source) in transform.fieldMap { next[target] = row[source] ?? .null }
				return next
			}
		}
		if let field = transform.sortField {
			rows.sort { a, b in
				let left = a[field] ?? .number(0)
				let right = b[field] ?? .number(0)
				if let l = left.number, let r = right.number { return transform.sortDescending ? l > r : l < r }
				let l = left.string ?? "", r = right.string ?? ""
				return transform.sortDescending ? l > r : l < r
			}
		}
		if let limit = transform.limit, limit > 0 { rows = Array(rows.prefix(limit)) }
		if let valueField = transform.flattenValueField {
			rows = rows.flatMap { row -> [[String: JSONValue]] in
				guard let series = row["series"]?.object else { return [] }
				var rest = row
				rest["series"] = nil
				return series.map { key, value in
					var next = rest
					next["name"] = .string(key)
					next[valueField] = value
					return next
				}
			}
		}
		if let ratio = transform.ratio {
			var byName: [String: Double] = [:]
			for row in rows { byName[row["name"]?.string ?? ""] = row["value"]?.number ?? 0 }
			let numerator = byName[ratio.numerator] ?? 0
			let denominator = ratio.denominators.reduce(0) { $0 + (byName[$1] ?? 0) }
			self = .value(.number(denominator > 0 ? numerator / denominator : 0))
			return
		}
		if let field = transform.reduceField {
			self = .value(.number(Self.reduce(rows, field: field, aggregate: transform.reduceAggregate)))
			return
		}
		self = .rows(rows)
	}

	private static func isHidden(_ name: String, _ bases: [String]) -> Bool {
		bases.contains { name == $0 || name.hasPrefix("\($0): ") || name == "\($0) (prev)" }
	}

	static func reduce(_ rows: [[String: JSONValue]], field: String, aggregate: String) -> Double {
		guard !rows.isEmpty else { return 0 }
		let hasField = rows.contains { row in
			switch row[field] {
			case .number, .string: true
			default: false
			}
		}
		// JSON key order is not kept, so "first numeric" is first by name here.
		let firstNumeric = rows[0]
			.filter { key, value in
				if case .number = value { return key != "bucket" }
				return false
			}
			.keys.sorted().first
		let resolved = hasField ? field : firstNumeric
		if resolved == nil, aggregate != "count" { return 0 }
		let values = rows.map { $0[resolved ?? ""]?.number ?? 0 }
		switch aggregate {
		case "sum": return values.reduce(0, +)
		case "count": return Double(rows.count)
		case "avg": return values.reduce(0, +) / Double(rows.count)
		case "max": return values.max() ?? 0
		case "min": return values.min() ?? 0
		default: return values.first ?? 0
		}
	}

	/// The number a stat tile shows.
	public var number: Double? {
		if case .value(let value) = self { return value.number }
		// Keys sorted, not dictionary order, so the same payload gives the same number every launch.
		if case .rows(let rows) = self, let first = rows.first {
			for key in first.keys.sorted() where key != "bucket" {
				if let number = first[key]?.number { return number }
			}
		}
		return nil
	}

	public var rows: [[String: JSONValue]] {
		if case .rows(let rows) = self { return rows }
		return []
	}
}

/// One widget's answer from `queryDashboardWidgetData`.
public struct WidgetOutcome: Hashable, Sendable {
	public enum Failure: String, Hashable, Sendable {
		case unsupported
		case notFound = "not_found"
		case failed
	}

	public let widgetId: String
	/// The raw payload; resolve it with the widget's transform via `WidgetData`.
	public let response: JSONValue?
	public let failure: Failure?
	public let message: String?

	init(_ outcome: Components.Schemas.DashboardWidgetDataOutcome) throws {
		widgetId = outcome.widgetId
		response = outcome.data.map(JSONValue.init)
		failure = outcome.ok ? nil : Failure(rawValue: outcome.reason?.rawValue ?? "failed") ?? .failed
		message = outcome.message
	}

	public init(widgetId: String, response: JSONValue?, failure: Failure? = nil, message: String? = nil) {
		self.widgetId = widgetId
		self.response = response
		self.failure = failure
		self.message = message
	}
}
