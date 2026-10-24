import Foundation
import OpenAPIRuntime

// The reads behind Explore, trace detail, triage actions and dashboards. Each
// wraps the same v2 operation the web dashboard's equivalent screen uses.

public typealias TraceSummary = Components.Schemas.TraceSummary
public typealias TraceDetail = Components.Schemas.Trace
public typealias TraceSpan = Components.Schemas.Span
public typealias LogRecord = Components.Schemas.Log

/// A trace search: the web's Traces page filters, narrowed to the chips the
/// phone offers.
public struct TraceSearch: Hashable, Sendable {
	public var window: ResolvedTimeWindow
	public var serviceName: String?
	public var errorsOnly: Bool
	public var minDurationMs: Double?
	public var spanName: String?
	public var rootOnly: Bool

	public init(
		window: ResolvedTimeWindow,
		serviceName: String? = nil,
		errorsOnly: Bool = false,
		minDurationMs: Double? = nil,
		spanName: String? = nil,
		rootOnly: Bool = true
	) {
		self.window = window
		self.serviceName = serviceName
		self.errorsOnly = errorsOnly
		self.minDurationMs = minDurationMs
		self.spanName = spanName
		self.rootOnly = rootOnly
	}
}

/// A log search: service, minimum severity, body text, or one trace's logs.
public struct LogSearch: Hashable, Sendable {
	public var window: ResolvedTimeWindow
	public var serviceName: String?
	/// OTel severity number floor: 13 warn, 17 error.
	public var minimumSeverity: Int?
	public var bodySearch: String?
	public var traceId: String?

	public init(
		window: ResolvedTimeWindow,
		serviceName: String? = nil,
		minimumSeverity: Int? = nil,
		bodySearch: String? = nil,
		traceId: String? = nil
	) {
		self.window = window
		self.serviceName = serviceName
		self.minimumSeverity = minimumSeverity
		self.bodySearch = bodySearch
		self.traceId = traceId
	}
}

extension MapleClient {
	public func searchTraces(_ search: TraceSearch, limit: Int = 50, cursor: String? = nil) async throws
		-> Page<TraceSummary>
	{
		try await mapping {
			let filters = Components.Schemas.TraceFilters(
				deploymentEnvironment: environment,
				hasError: search.errorsOnly ? true : nil,
				minDurationMs: search.minDurationMs,
				serviceName: search.serviceName,
				spanName: search.spanName.flatMap { $0.isEmpty ? nil : $0 },
				spanScope: search.rootOnly ? .root : nil
			)
			let output = try await client.searchTraces(
				.init(
					body: .json(
						.init(
							cursor: cursor,
							endTime: search.window.endTime,
							filters: filters,
							limit: limit,
							startTime: search.window.startTime
						)
					)
				)
			)
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	public func trace(id: String) async throws -> TraceDetail {
		try await mapping {
			try await client.getTrace(.init(path: .init(traceId: id))).ok.body.json
		}
	}

	public func searchLogs(_ search: LogSearch, limit: Int = 50, cursor: String? = nil) async throws
		-> Page<LogRecord>
	{
		try await mapping {
			let output = try await client.searchLogs(
				.init(
					body: .json(
						.init(
							cursor: cursor,
							endTime: search.window.endTime,
							filters: logFilters(search),
							limit: limit,
							startTime: search.window.startTime
						)
					)
				)
			)
			let list = try output.ok.body.json
			return Page(items: list.data, hasMore: list.hasMore, nextCursor: list.nextCursor)
		}
	}

	/// Log volume per bucket for the same filters as the list under it.
	public func logVolume(_ search: LogSearch, targetPoints: Int = 40) async throws -> [Double] {
		try await mapping {
			let output = try await client.queryLogTimeseries(
				.init(
					body: .json(
						.init(
							aggregation: .count,
							bucketSeconds: search.window.bucketSeconds(targetPoints: targetPoints),
							endTime: search.window.endTime,
							filters: logFilters(search),
							startTime: search.window.startTime
						)
					)
				)
			)
			return try output.ok.body.json.series.first?.points.map(\.value) ?? []
		}
	}

	func logFilters(_ search: LogSearch) -> Components.Schemas.LogFilters {
		.init(
			bodySearch: search.bodySearch.flatMap { $0.isEmpty ? nil : $0 },
			deploymentEnvironment: environment,
			minimumSeverity: search.minimumSeverity,
			serviceName: search.serviceName,
			traceId: search.traceId
		)
	}

	// MARK: Triage actions

	public func transitionIssue(id: String, to state: WorkflowState, note: String?) async throws -> ErrorIssue {
		try await mapping {
			try await client.transitionErrorIssue(
				.init(path: .init(id: id), body: .json(.init(note: note, toState: state)))
			).ok.body.json
		}
	}

	public func claimIssue(id: String) async throws -> ErrorIssue {
		try await mapping {
			try await client.claimErrorIssue(.init(path: .init(id: id), body: .json(.init()))).ok.body.json
		}
	}

	public func releaseIssue(id: String) async throws -> ErrorIssue {
		try await mapping {
			try await client.releaseErrorIssue(.init(path: .init(id: id), body: .json(.init()))).ok.body.json
		}
	}

	public func setIssueSeverity(id: String, severity: IssueSeverity?) async throws -> ErrorIssue {
		try await mapping {
			try await client.setErrorIssueSeverity(
				.init(path: .init(id: id), body: .json(.init(severity: severity)))
			).ok.body.json
		}
	}

	// MARK: Dashboards

	public func dashboards(limit: Int = 50, cursor: String? = nil) async throws -> Page<DashboardSummary> {
		try await mapping {
			let output = try await client.listDashboards(.init(query: .init(limit: String(limit), cursor: cursor)))
			let list = try output.ok.body.json
			return Page(
				items: list.data.map(DashboardSummary.init),
				hasMore: list.hasMore,
				nextCursor: list.nextCursor
			)
		}
	}

	public func dashboard(id: String) async throws -> MobileDashboard {
		try await mapping {
			try MobileDashboard(try await client.getDashboard(.init(path: .init(id: id))).ok.body.json)
		}
	}

	/// The board's own queries, built and run server-side for each widget, the
	/// same evaluation the web board and share links use. At most four per call.
	public func dashboardWidgetData(
		dashboardId: String,
		widgetIds: [String],
		window: ResolvedTimeWindow,
		maxDataPoints: Int = 48
	) async throws -> [WidgetOutcome] {
		try await mapping {
			let output = try await client.queryDashboardWidgetData(
				.init(
					path: .init(id: dashboardId),
					body: .json(
						.init(
							requests: widgetIds.prefix(4).map {
								.init(maxDataPoints: maxDataPoints, source: .primary, widgetId: $0)
							},
							timeRange: .init(
								value2: .init(endTime: window.endTime, startTime: window.startTime, _type: .absolute)
							)
						)
					)
				)
			)
			return try output.ok.body.json.results.map(WidgetOutcome.init)
		}
	}
}

extension Components.Schemas.Span: Identifiable {}
extension Components.Schemas.TraceSummary: Identifiable {}
extension Components.Schemas.Log: Identifiable {}
