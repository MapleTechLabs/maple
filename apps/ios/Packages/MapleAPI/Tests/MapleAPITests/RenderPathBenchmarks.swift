import Foundation
import Testing

@testable import MapleAPI

/// Timings for the work the new screens do on the main thread. Correctness is
/// asserted; the durations are printed, not asserted, because they vary by machine.
/// Run in release: `swift test -c release -Xswiftc -enable-testing --filter RenderPathBenchmarks`.
struct RenderPathBenchmarks {
	private static func trace(spans count: Int, fanout: Int) -> TraceDetail {
		let start = Date(timeIntervalSince1970: 1_800_000_000)
		let spans = (0..<count).map { index in
			TraceSpan(
				attributes: .init(additionalProperties: ["http.route": "/r/\(index % 50)"]),
				durationMs: Double(count - index),
				id: String(format: "%016x", index + 1),
				kind: "Internal",
				name: "span \(index)",
				object: .span,
				parentSpanId: index == 0 ? nil : String(format: "%016x", (index - 1) / fanout + 1),
				resourceAttributes: .init(additionalProperties: ["service.name": "svc-\(index % 12)"]),
				serviceName: "svc-\(index % 12)",
				startTime: ResolvedTimeWindow.format(start.addingTimeInterval(Double(index) / 1000)),
				statusCode: index % 97 == 0 ? "Error" : "Ok",
				traceId: "t"
			)
		}
		return TraceDetail(
			durationMs: Double(count),
			endTime: ResolvedTimeWindow.format(start.addingTimeInterval(Double(count) / 1000)),
			id: "t",
			object: .trace,
			serviceCount: 12,
			spanCount: Double(count),
			spans: spans.reversed(),
			startTime: ResolvedTimeWindow.format(start),
			truncated: false
		)
	}

	private static func time<T>(_ label: String, runs: Int = 5, _ work: () throws -> T) rethrows -> T {
		var result: T?
		var best = Duration.seconds(1_000)
		for _ in 0..<runs {
			let clock = ContinuousClock()
			let started = clock.now
			result = try work()
			best = min(best, clock.now - started)
		}
		let ms = Double(best.components.attoseconds) / 1e15 + Double(best.components.seconds) * 1000
		print("BENCH \(label): \(String(format: "%.2f", ms)) ms (best of \(runs))")
		return result!
	}

	@Test func waterfallLayout() {
		for count in [1_000, 10_000] {
			let trace = Self.trace(spans: count, fanout: 8)
			let rows = Self.time("waterfall \(count) spans, fanout 8") { WaterfallRow.layout(trace) }
			#expect(rows.count == count)
			#expect(rows.first?.depth == 0)
		}
	}

	@Test func waterfallDeepChain() {
		let trace = Self.trace(spans: 2_000, fanout: 1)
		let rows = Self.time("waterfall 2000-deep chain") { WaterfallRow.layout(trace) }
		#expect(rows.count == 2_000)
		#expect(rows.last?.depth == 1_999)
	}

	private static func payload(rows: Int, series: Int) -> String {
		let body = (0..<rows).map { row in
			let values = (0..<series).map { "\"s\($0)\":\(Double(row * $0) / 3)" }.joined(separator: ",")
			return "{\"bucket\":\"2026-10-20T\(String(format: "%02d", row % 24)):00:00.000Z\",\(values)}"
		}
		return "{\"widget_id\":\"w\",\"ok\":true,\"data\":{\"data\":[\(body.joined(separator: ","))]}}"
	}

	@Test func widgetOutcomeDecodeAndReduce() throws {
		let json = Data(Self.payload(rows: 5_000, series: 5).utf8)
		let outcome = try Self.time("decode generated outcome, 5000 rows x 5 series") {
			try JSONDecoder().decode(Components.Schemas.DashboardWidgetDataOutcome.self, from: json)
		}
		let resolved = try Self.time("re-read as JSONValue (WidgetOutcome.init)") { try WidgetOutcome(outcome) }
		var transform = WidgetTransform()
		transform.reduceField = "s3"
		transform.reduceAggregate = "avg"
		let data = Self.time("transform + reduce, 5000 rows") {
			WidgetData(response: resolved.response ?? .null, transform: transform)
		}
		#expect(data.number != nil)
		let rows = Self.time("untransformed rows, 5000 rows") {
			WidgetData(response: resolved.response ?? .null, transform: nil).rows
		}
		#expect(rows.count == 5_000)
	}
}
