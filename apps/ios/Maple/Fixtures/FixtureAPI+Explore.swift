import Foundation
import MapleAPI

// Fixture traces, logs, triage actions and one dashboard, so Explore and trace
// detail render without a backend. Same believable org as FixtureAPI.

extension FixtureAPI {
	private static let checkoutTrace = "7f3a4b5c6d7e8f901234567890abcdef"

	/// (service, span, kind, parent index, start offset ms, duration ms, error)
	private static let checkoutSpans: [(String, String, String, Int?, Double, Double, Bool)] = [
		("web", "GET /checkout", "Server", nil, 0, 1_420, true),
		("checkout-api", "POST /v1/checkout", "Server", 0, 12, 1_390, true),
		("auth", "verify session", "Internal", 1, 18, 22, false),
		("catalog", "load cart items", "Client", 1, 44, 96, false),
		("catalog", "SELECT cart_items", "Client", 3, 50, 81, false),
		("payments", "charge card", "Client", 1, 150, 1_180, true),
		("payments", "POST stripe /v1/charges", "Client", 5, 160, 1_150, true),
		("notifications", "enqueue receipt", "Producer", 1, 1_340, 14, false),
	]

	func searchTraces(_ search: TraceSearch, limit: Int, cursor: String?) async throws -> Page<TraceSummary> {
		try await pause()
		let routes: [(String, String, Double, Bool)] = [
			("web", "GET /checkout", 1_420, true),
			("search", "GET /search", 1_340, false),
			("checkout-api", "POST /v1/checkout", 640, true),
			("web", "GET /", 140, false),
			("auth", "POST /session", 61, false),
			("payments", "POST /charges", 410, false),
			("catalog", "GET /products/:id", 190, false),
			("web", "GET /product/:slug", 220, false),
		]
		var items = (0..<24).map { index -> TraceSummary in
			let route = routes[index % routes.count]
			let jitter = Double((index * 37) % 50) / 100 + 0.75
			return TraceSummary(
				durationMs: route.2 * jitter,
				httpMethod: String(route.1.split(separator: " ").first ?? "GET"),
				httpRoute: String(route.1.split(separator: " ").last ?? "/"),
				httpStatusCode: route.3 ? "500" : "200",
				id: index == 0 ? Self.checkoutTrace : String(format: "%032x", index * 7_919),
				object: .trace,
				rootHasError: route.3,
				rootServiceName: route.0,
				rootSpanKind: "Server",
				rootSpanName: route.1,
				rootStatusCode: route.3 ? "Error" : "Ok",
				startTime: stamp(-Double(index) * 95)
			)
		}
		if let service = search.serviceName { items = items.filter { $0.rootServiceName == service } }
		if search.errorsOnly { items = items.filter(\.rootHasError) }
		if let minimum = search.minDurationMs { items = items.filter { $0.durationMs >= minimum } }
		return Page(items: Array(items.prefix(limit)), hasMore: false, nextCursor: nil)
	}

	/// `MAPLE_FIXTURES_TRACE_SPANS=<n>` serves an n-span trace instead, for
	/// measuring the waterfall on a large trace.
	private static let largeTraceSpans = ProcessInfo.processInfo.environment["MAPLE_FIXTURES_TRACE_SPANS"].flatMap(Int.init)

	private func largeTrace(id: String, spans count: Int) -> TraceDetail {
		let start = Date().addingTimeInterval(-120)
		let services = ["web", "checkout-api", "payments", "catalog", "auth", "search"]
		let spans: [TraceSpan] = (0..<count).map { index in
			let service: String = services[index % services.count]
			let statement: String = "SELECT * FROM items WHERE id = " + String(index)
			let parent: String? = index == 0 ? nil : String(format: "%016x", (index - 1) / 8 + 1)
			let startTime: String = ResolvedTimeWindow.format(start.addingTimeInterval(Double(index) / 10_000))
			return TraceSpan(
				attributes: TraceSpan.AttributesPayload(additionalProperties: ["db.statement": statement]),
				durationMs: Double(count - index) / 10,
				id: String(format: "%016x", index + 1),
				kind: "Internal",
				name: "span " + String(index),
				object: .span,
				parentSpanId: parent,
				resourceAttributes: TraceSpan.ResourceAttributesPayload(additionalProperties: ["service.name": service]),
				serviceName: service,
				startTime: startTime,
				statusCode: index % 97 == 0 ? "Error" : "Ok",
				traceId: id
			)
		}
		return TraceDetail(
			durationMs: Double(count) / 10,
			endTime: ResolvedTimeWindow.format(start.addingTimeInterval(Double(count) / 10_000)),
			id: id, object: .trace, serviceCount: 9, spanCount: Double(count), spans: spans,
			startTime: ResolvedTimeWindow.format(start), truncated: false
		)
	}

	func trace(id: String) async throws -> TraceDetail {
		try await pause()
		if let count = Self.largeTraceSpans { return largeTrace(id: id, spans: count) }
		let start = Date().addingTimeInterval(-120)
		let ids = Self.checkoutSpans.indices.map { String(format: "%016x", 0xa1b2c3 + $0) }
		let spans = Self.checkoutSpans.enumerated().map { index, seed in
			TraceSpan(
				attributes: .init(additionalProperties: seed.6
					? ["http.status_code": "502", "error.type": "UpstreamTimeout", "peer.service": "stripe"]
					: ["http.status_code": "200"]),
				durationMs: seed.5,
				id: ids[index],
				kind: seed.2,
				name: seed.1,
				object: .span,
				parentSpanId: seed.3.map { ids[$0] },
				resourceAttributes: .init(additionalProperties: [
					"service.name": seed.0, "deployment.environment": "production", "service.version": "2026.10.20",
				]),
				serviceName: seed.0,
				startTime: ResolvedTimeWindow.format(start.addingTimeInterval(seed.4 / 1000)),
				statusCode: seed.6 ? "Error" : "Ok",
				statusMessage: seed.6 ? "upstream request timed out after 1.1s" : nil,
				traceId: id
			)
		}
		return TraceDetail(
			durationMs: 1_420,
			endTime: ResolvedTimeWindow.format(start.addingTimeInterval(1.42)),
			id: id,
			object: .trace,
			serviceCount: 6,
			spanCount: Double(spans.count),
			spans: spans,
			startTime: ResolvedTimeWindow.format(start),
			truncated: false
		)
	}

	func searchLogs(_ search: LogSearch, limit: Int, cursor: String?) async throws -> Page<LogRecord> {
		try await pause()
		let lines: [(String, String, Int, String)] = [
			("payments", "ERROR", 17, "charge failed: upstream request timed out after 1100ms"),
			("checkout-api", "ERROR", 17, "checkout aborted: payment step failed (UpstreamTimeout)"),
			("checkout-api", "WARN", 13, "retrying payment attempt 2/3"),
			("web", "INFO", 9, "GET /checkout 500 1420ms"),
			("search", "WARN", 13, "slow query: 1.3s for q=\"running shoes\""),
			("auth", "INFO", 9, "session verified user=u_81f2"),
			("catalog", "INFO", 9, "cart loaded items=3"),
			("worker", "INFO", 9, "job email.receipt completed in 380ms"),
			("ingest-gateway", "DEBUG", 5, "flushed batch size=512"),
		]
		var items = (0..<36).map { index -> LogRecord in
			let line = lines[index % lines.count]
			let inTrace = index % lines.count < 4
			return LogRecord(
				body: line.3,
				id: "log_\(index)",
				logAttributes: .init(additionalProperties: ["code.function": "handle", "thread": "\(index % 4)"]),
				object: .log,
				resourceAttributes: .init(additionalProperties: ["service.name": line.0]),
				serviceName: line.0,
				severityNumber: Double(line.2),
				severityText: line.1,
				spanId: inTrace ? String(format: "%016x", 0xa1b2c3 + 5) : nil,
				timestamp: stamp(-Double(index) * 41),
				traceId: inTrace ? Self.checkoutTrace : nil
			)
		}
		if let service = search.serviceName { items = items.filter { $0.serviceName == service } }
		if let minimum = search.minimumSeverity { items = items.filter { Int($0.severityNumber) >= minimum } }
		if let text = search.bodySearch, !text.isEmpty {
			items = items.filter { $0.body.localizedCaseInsensitiveContains(text) }
		}
		if let traceId = search.traceId { items = items.filter { $0.traceId == traceId } }
		return Page(items: Array(items.prefix(limit)), hasMore: false, nextCursor: nil)
	}

	func logVolume(_ search: LogSearch, targetPoints: Int) async throws -> [Double] {
		try await pause()
		return (0..<targetPoints).map { index -> Double in
			let base = 120 + 40 * sin(Double(index) / 4)
			return (index > targetPoints - 8 ? base * 2.4 : base).rounded()
		}
	}

	// MARK: Triage actions

	private func updated(_ id: String, _ change: (inout ErrorIssue) -> Void) async throws -> ErrorIssue {
		try await pause()
		guard var issue = issues.first(where: { $0.id == id }) else {
			throw MapleAPIError.decoding(NSError(domain: "fixtures", code: 404))
		}
		change(&issue)
		return issue
	}

	func transitionIssue(id: String, to state: WorkflowState, note: String?) async throws -> ErrorIssue {
		try await updated(id) { $0.workflowState = state }
	}

	func claimIssue(id: String) async throws -> ErrorIssue {
		try await updated(id) { issue in
			issue.workflowState = .inProgress
			issue.claimedAt = stamp(0)
		}
	}

	func releaseIssue(id: String) async throws -> ErrorIssue {
		try await updated(id) { $0.claimedAt = nil }
	}

	func setIssueSeverity(id: String, severity: IssueSeverity?) async throws -> ErrorIssue {
		try await updated(id) { $0.severity = severity }
	}

	// MARK: Dashboards

	private var dashboardSummaries: [DashboardSummary] {
		[
			DashboardSummary(id: "dash_checkout", name: "Checkout health", description: "Golden signals for the purchase path", tags: ["commerce"], widgetCount: 8, updatedAt: stamp(-3_600)),
			DashboardSummary(id: "dash_edge", name: "Edge traffic", description: nil, tags: ["edge"], widgetCount: 4, updatedAt: stamp(-86_400 * 2)),
			DashboardSummary(id: "dash_db", name: "Database queries", description: "Slowest statements by service", tags: [], widgetCount: 5, updatedAt: stamp(-86_400 * 9)),
		]
	}

	func dashboards(limit: Int, cursor: String?) async throws -> Page<DashboardSummary> {
		try await pause()
		return Page(items: dashboardSummaries, hasMore: false, nextCursor: nil)
	}

	func dashboard(id: String) async throws -> MobileDashboard {
		try await pause()
		var reduce = WidgetTransform()
		reduce.reduceField = "value"
		reduce.reduceAggregate = "sum"
		// Every fixture board shares one widget set but keeps its own title.
		let summary = dashboardSummaries.first { $0.id == id }
		return MobileDashboard(
			id: id,
			name: summary?.name ?? "Checkout health",
			description: summary?.description,
			relativeRange: "24h",
			widgets: [
				MobileWidget(id: "w_req", visualization: "stat", title: "Requests", transform: reduce, x: 0, y: 0, w: 6),
				MobileWidget(id: "w_err", visualization: "stat", title: "Error rate", unit: "percent", transform: reduce, x: 6, y: 0, w: 6),
				MobileWidget(id: "w_p95", visualization: "stat", title: "Checkout p95", unit: "duration_ms", x: 0, y: 1, w: 6),
				MobileWidget(id: "w_svc", visualization: "stat", title: "Services", x: 6, y: 1, w: 6),
				MobileWidget(id: "w_lat", visualization: "chart", title: "Latency by percentile", unit: "duration_ms", x: 0, y: 2),
				MobileWidget(id: "w_vol", visualization: "chart", title: "Requests by service", x: 0, y: 4),
				MobileWidget(id: "w_top", visualization: "hbar", title: "Errors by service", x: 0, y: 6),
				MobileWidget(id: "w_slow", visualization: "table", title: "Slowest endpoints", unit: "duration_ms", x: 0, y: 8),
			]
		)
	}

	func dashboardWidgetData(dashboardId: String, widgetIds: [String], window: ResolvedTimeWindow, maxDataPoints: Int)
		async throws -> [WidgetOutcome]
	{
		try await pause()
		let points = 24
		let buckets = (0..<points).map { stamp(-Double(points - $0) * 3_600) }
		func series(_ build: (Int) -> [String: Double]) -> JSONValue {
			.object(["data": .array(buckets.enumerated().map { index, bucket -> JSONValue in
				var row: [String: JSONValue] = ["bucket": .string(bucket)]
				for (key, value) in build(index) { row[key] = .number(value) }
				return .object(row)
			})])
		}
		return widgetIds.map { id -> WidgetOutcome in
			let response: JSONValue? =
				switch id {
				case "w_req": series { ["value": 4_800 + Double(($0 * 53) % 900)] }
				case "w_err": .object(["data": .array([.object(["value": .number(0.0123)])])])
				case "w_p95": .object(["data": .array([.object(["value": .number(612)])])])
				case "w_svc": .object(["data": .array([.object(["value": .number(9)])])])
				case "w_lat": series { index in
					let spike = index > 18 ? 2.2 : 1
					return ["p50": 84 + Double(index % 5) * 3, "p95": 410 * spike + Double(index % 7) * 12, "p99": 980 * spike + Double(index % 3) * 40]
				}
				case "w_vol": series { index in
					["web": 3_800 + Double((index * 71) % 600), "checkout-api": 1_500 + Double((index * 31) % 300), "payments": 350 + Double((index * 17) % 90)]
				}
				case "w_top": .object(["data": .array([
					.object(["name": .string("checkout-api"), "value": .number(1_284)]),
					.object(["name": .string("payments"), "value": .number(412)]),
					.object(["name": .string("search"), "value": .number(96)]),
					.object(["name": .string("web"), "value": .number(31)]),
				])])
				case "w_slow": .object(["data": .array([
					.object(["name": .string("POST /v1/checkout"), "p50": .number(86), "p95": .number(1_390), "p99": .number(1_480)]),
					.object(["name": .string("GET /search"), "p50": .number(64), "p95": .number(488), "p99": .number(820)]),
					.object(["name": .string("POST /charges"), "p50": .number(142), "p95": .number(388), "p99": .number(903)]),
					.object(["name": .string("GET /products/:id"), "p50": .number(24), "p95": .number(118), "p99": .number(402)]),
				])])
				default: nil
				}
			return response.map { WidgetOutcome(widgetId: id, response: $0) }
				?? WidgetOutcome(widgetId: id, response: nil, failure: .notFound, message: "That widget is not on this dashboard.")
		}
	}
}
