import Foundation
import Testing

@testable import MapleAPI

struct WaterfallTests {
	private func span(_ id: String, parent: String?, at offsetMs: Double) -> TraceSpan {
		let start = Date(timeIntervalSince1970: 1_800_000_000).addingTimeInterval(offsetMs / 1000)
		return TraceSpan(
			attributes: .init(additionalProperties: [:]),
			durationMs: 10,
			id: id,
			kind: "Internal",
			name: id,
			object: .span,
			parentSpanId: parent,
			resourceAttributes: .init(additionalProperties: [:]),
			serviceName: "svc",
			startTime: ResolvedTimeWindow.format(start),
			statusCode: "Ok",
			traceId: "t"
		)
	}

	private func trace(_ spans: [TraceSpan]) -> TraceDetail {
		TraceDetail(
			durationMs: 100, endTime: "", id: "t", object: .trace, serviceCount: 1,
			spanCount: Double(spans.count), spans: spans, startTime: "", truncated: false
		)
	}

	@Test func childrenFollowParentsInStartOrder() {
		let rows = WaterfallRow.layout(trace([
			span("late", parent: "root", at: 20),
			span("root", parent: nil, at: 0),
			span("early", parent: "root", at: 5),
		]))
		#expect(rows.map(\.id) == ["root", "early", "late"])
		#expect(rows.map(\.depth) == [0, 1, 1])
	}

	@Test func orphansBecomeRoots() {
		let rows = WaterfallRow.layout(trace([span("orphan", parent: "missing", at: 0)]))
		#expect(rows.map(\.id) == ["orphan"])
		#expect(rows.first?.depth == 0)
	}

	@Test func spansInAParentCycleAreKept() {
		let rows = WaterfallRow.layout(trace([
			span("root", parent: nil, at: 0),
			span("a", parent: "b", at: 10),
			span("b", parent: "a", at: 20),
			span("child", parent: "a", at: 30),
		]))
		#expect(rows.count == 4)
		#expect(Set(rows.map(\.id)) == ["root", "a", "b", "child"])
	}
}
