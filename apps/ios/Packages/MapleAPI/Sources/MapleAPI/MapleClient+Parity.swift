import Foundation

// Reads that run the same server query as the web dashboard's screen, so one
// query gets tuned for both clients.

public typealias ServiceHealthEntry = Components.Schemas.ServiceHealthEntry
public typealias AlertRulePreview = Components.Schemas.AlertRulePreviewResult
public typealias AlertRulePreviewPoint = Components.Schemas.AlertRulePreviewPoint

/// Per-service golden signals for a window and the equally long window before
/// it: the web overview's `serviceHealthSnapshot`.
public struct ServiceHealthSnapshot: Hashable, Sendable {
	public let services: [ServiceHealthEntry]
	/// Nil when no comparison window was asked for.
	public let previous: [ServiceHealthEntry]?

	public init(services: [ServiceHealthEntry], previous: [ServiceHealthEntry]?) {
		self.services = services
		self.previous = previous
	}
}

/// Log volume per bucket, split by severity the way the web's histogram is.
public struct LogVolume: Hashable, Sendable {
	public struct Series: Hashable, Sendable {
		/// The severity text, `ERROR`, `WARN`, ...
		public let severity: String
		public let values: [Double]

		public init(severity: String, values: [Double]) {
			self.severity = severity
			self.values = values
		}
	}

	public let series: [Series]

	public init(series: [Series]) {
		self.series = series
	}

	/// Every severity summed per bucket.
	public var totals: [Double] {
		let width = series.map(\.values.count).max() ?? 0
		return (0..<width).map { index in
			series.reduce(0) { $0 + (index < $1.values.count ? $1.values[index] : 0) }
		}
	}
}

extension MapleClient {
	public func serviceHealth(window: ResolvedTimeWindow, comparing previous: ResolvedTimeWindow?) async throws
		-> ServiceHealthSnapshot
	{
		try await mapping {
			let output = try await client.queryServiceHealth(
				.init(
					body: .json(
						.init(
							deploymentEnvironment: environment,
							endTime: window.endTime,
							previousEndTime: previous?.endTime,
							previousStartTime: previous?.startTime,
							startTime: window.startTime
						)
					)
				)
			)
			let body = try output.ok.body.json
			return ServiceHealthSnapshot(services: body.services, previous: body.previous?.services)
		}
	}

	public func logVolumeBySeverity(_ search: LogSearch, targetPoints: Int = 40) async throws -> LogVolume {
		try await mapping {
			let output = try await client.queryLogTimeseries(
				.init(
					body: .json(
						.init(
							aggregation: .count,
							bucketSeconds: search.window.bucketSeconds(targetPoints: targetPoints),
							endTime: search.window.endTime,
							filters: logFilters(search),
							groupBy: .severity,
							startTime: search.window.startTime
						)
					)
				)
			)
			let series = try output.ok.body.json.series.map { series in
				LogVolume.Series(severity: series.group ?? "UNSET", values: series.points.map(\.value))
			}
			return LogVolume(series: series)
		}
	}

	/// What the rule's own evaluator saw over a window: the chart the web's
	/// incident page draws, rather than a generic service metric.
	public func previewAlertRule(_ rule: AlertRule, window: ResolvedTimeWindow) async throws -> AlertRulePreview {
		let definition = try AlertRuleDefinition.createParams(from: rule)
		return try await mapping {
			try await client.previewAlertRule(
				.init(body: .json(.init(endTime: window.endTime, rule: definition, startTime: window.startTime)))
			).ok.body.json
		}
	}
}

/// Turns a saved rule back into the create shape the preview endpoint takes.
enum AlertRuleDefinition {
	/// Create params are a subset of the rule's fields; the rest is bookkeeping.
	static func createParams(from rule: AlertRule) throws -> Components.Schemas.AlertRuleCreateParams {
		let encoded = try JSONEncoder().encode(rule)
		guard var fields = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
			throw MapleAPIError.decoding(CocoaError(.coderReadCorrupt))
		}
		fields = fields.filter { allowedKeys.contains($0.key) && !($0.value is NSNull) }
		if let groupBy = fields["group_by"] as? [Any], groupBy.isEmpty { fields["group_by"] = nil }
		// A tiered rule carries its severities and destinations in `thresholds`;
		// the single-threshold fields beside them are derived and rejected on create.
		if fields["thresholds"] != nil {
			for key in ["severity", "threshold", "threshold_upper", "destination_ids"] { fields[key] = nil }
		}
		let data = try JSONSerialization.data(withJSONObject: fields)
		return try JSONDecoder().decode(Components.Schemas.AlertRuleCreateParams.self, from: data)
	}

	/// `AlertRuleCreateParams`' properties in openapi.json; the decode below
	/// fails loudly if the spec gains a required one.
	private static let allowedKeys: Set<String> = [
		"alert_on_no_data",
		"apdex_threshold_ms",
		"breaches_out_of",
		"comparator",
		"consecutive_breaches_required",
		"consecutive_healthy_required",
		"destination_ids",
		"enabled",
		"environments",
		"evaluation_interval_minutes",
		"exclude_service_names",
		"group_by",
		"minimum_sample_count",
		"name",
		"notes",
		"notification_template",
		"query_builder_draft",
		"raw_query_reducer",
		"raw_query_sql",
		"renotify_interval_minutes",
		"service_names",
		"severity",
		"signal_type",
		"tags",
		"threshold",
		"threshold_upper",
		"thresholds",
		"window_minutes",
	]
}
