import Foundation
import OpenAPIRuntime

/// A trace timeseries query, narrowed to the shape the app needs: one
/// aggregation, one window, optionally one service or one series per group.
/// `bucketSeconds` defaults to whatever gives the window roughly
/// `TraceTimeseriesRequest.targetPoints` points, so a sparkline on a 1h window
/// and one on a 7d window carry the same visual density.
public struct TraceTimeseriesRequest: Hashable, Sendable {
	public var aggregation: TraceAggregation
	public var window: ResolvedTimeWindow
	public var serviceName: String?
	public var hasError: Bool?
	public var bucketSeconds: Int?
	/// One series per group instead of one series overall. The widget uses
	/// `.service` to get every service's shape from a single request rather
	/// than one request per service.
	public var groupBy: TraceTimeseriesGroup?
	/// How many groups to return. Ignored without `groupBy`.
	public var seriesLimit: Int?

	public static let targetPoints = 40

	public init(
		aggregation: TraceAggregation,
		window: ResolvedTimeWindow,
		serviceName: String? = nil,
		hasError: Bool? = nil,
		bucketSeconds: Int? = nil,
		groupBy: TraceTimeseriesGroup? = nil,
		seriesLimit: Int? = nil
	) {
		self.aggregation = aggregation
		self.window = window
		self.serviceName = serviceName
		self.hasError = hasError
		self.bucketSeconds = bucketSeconds
		self.groupBy = groupBy
		self.seriesLimit = seriesLimit
	}

	/// Snapped to a minute multiple: the server rounds anyway, and a whole
	/// number of minutes keeps bucket boundaries aligned with the window's
	/// minute-snapped end.
	public var resolvedBucketSeconds: Int {
		bucketSeconds ?? window.bucketSeconds(targetPoints: Self.targetPoints)
	}
}

/// The service detail screen's one read: the window summary, every golden
/// signal per bucket, and the busiest operations, composed server-side.
public struct ServiceOverviewRequest: Hashable, Sendable {
	public var serviceName: String
	public var window: ResolvedTimeWindow
	/// Buckets behind the chart. The default is denser than a sparkline's
	/// because this series is drawn full-width and scrubbed by hand.
	public var bucketSeconds: Int?

	public static let targetPoints = 48

	public init(serviceName: String, window: ResolvedTimeWindow, bucketSeconds: Int? = nil) {
		self.serviceName = serviceName
		self.window = window
		self.bucketSeconds = bucketSeconds
	}

	public var resolvedBucketSeconds: Int {
		bucketSeconds ?? window.bucketSeconds(targetPoints: Self.targetPoints)
	}
}

public struct TraceBreakdownRequest: Hashable, Sendable {
	public var aggregation: TraceBreakdownAggregation
	public var groupBy: TraceBreakdownGroup
	public var window: ResolvedTimeWindow
	public var serviceName: String?
	public var hasError: Bool?
	public var limit: Int

	public init(
		aggregation: TraceBreakdownAggregation,
		groupBy: TraceBreakdownGroup,
		window: ResolvedTimeWindow,
		serviceName: String? = nil,
		hasError: Bool? = nil,
		limit: Int = 5
	) {
		self.aggregation = aggregation
		self.groupBy = groupBy
		self.window = window
		self.serviceName = serviceName
		self.hasError = hasError
		self.limit = limit
	}
}

extension MapleClient {
	public func serviceOverview(_ request: ServiceOverviewRequest) async throws -> ServiceOverview {
		try await mapping {
			let output = try await client.getServiceOverview(
				.init(
					path: .init(name: request.serviceName),
					query: .init(
						startTime: request.window.startTime,
						endTime: request.window.endTime,
						deploymentEnvironment: environment,
						bucketSeconds: String(request.resolvedBucketSeconds)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	public func traceTimeseries(_ request: TraceTimeseriesRequest) async throws -> TraceTimeseriesResult {
		try await mapping {
			let output = try await client.queryTraceTimeseries(
				.init(
					body: .json(
						.init(
							aggregation: request.aggregation,
							bucketSeconds: request.resolvedBucketSeconds,
							endTime: request.window.endTime,
							filters: filters(serviceName: request.serviceName, hasError: request.hasError),
							groupBy: request.groupBy,
							seriesLimit: request.groupBy == nil ? nil : request.seriesLimit,
							startTime: request.window.startTime
						)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	public func traceBreakdown(_ request: TraceBreakdownRequest) async throws -> TraceBreakdownResult {
		try await mapping {
			let output = try await client.queryTraceBreakdown(
				.init(
					body: .json(
						.init(
							aggregation: request.aggregation,
							endTime: request.window.endTime,
							filters: filters(serviceName: request.serviceName, hasError: request.hasError),
							groupBy: request.groupBy,
							limit: request.limit,
							startTime: request.window.startTime
						)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	/// The environment comes from the client's scope rather than the request:
	/// it is a property of what the user is looking at, not of one chart.
	///
	/// Note the guard covers it too. Before, an environment-only filter would
	/// have fallen through to `nil` and been dropped on the floor — the request
	/// would still succeed, and the chart would quietly show every environment.
	private func filters(serviceName: String?, hasError: Bool?) -> Components.Schemas.TraceFilters? {
		guard serviceName != nil || hasError != nil || environment != nil else { return nil }
		return .init(deploymentEnvironment: environment, hasError: hasError, serviceName: serviceName)
	}
}

extension TraceTimeseriesResult {
	/// The values of the first (only, when ungrouped) series, in order.
	public var values: [Double] {
		series.first?.points.map(\.value) ?? []
	}

	/// A grouped result as `group name → values`. Series without a group are
	/// dropped: with `groupBy` set they cannot be attributed to anything, and
	/// silently folding them into one bucket would double-count.
	public var valuesByGroup: [String: [Double]] {
		Dictionary(
			series.compactMap { series in series.group.map { ($0, series.points.map(\.value)) } },
			uniquingKeysWith: { first, _ in first }
		)
	}
}
