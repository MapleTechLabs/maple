import Foundation

/// One span placed in the waterfall: its depth in the tree and its offset and
/// width as fractions of the trace.
public struct WaterfallRow: Identifiable, Hashable, Sendable {
	public let span: TraceSpan
	public let depth: Int
	public let offset: Double
	public let width: Double
	public var id: String { span.id }
	public var isError: Bool { span.statusCode == "Error" }

	/// Depth-first, children in start order, so the list reads like the web
	/// waterfall turned on its side. Orphans (parent outside a truncated trace)
	/// become roots rather than disappearing.
	///
	/// Iterative with an explicit stack: a recursive walk overflowed the stack on
	/// a 2,000-deep span chain. Each timestamp is parsed once, not per comparison.
	public static func layout(_ trace: TraceDetail) -> [WaterfallRow] {
		let spans = trace.spans
		let starts = spans.map { ResolvedTimeWindow.parse($0.startTime)?.timeIntervalSince1970 }
		let origin = starts.compactMap { $0 }.min() ?? 0
		let begins = starts.map { (($0 ?? origin) - origin) * 1000 }
		let total = max(trace.durationMs, 1)

		var indexById: [String: Int] = [:]
		indexById.reserveCapacity(spans.count)
		for (index, span) in spans.enumerated() { indexById[span.id] = index }

		var roots: [Int] = []
		var children: [Int: [Int]] = [:]
		for (index, span) in spans.enumerated() {
			if let parent = span.parentSpanId.flatMap({ indexById[$0] }), parent != index {
				children[parent, default: []].append(index)
			} else {
				roots.append(index)
			}
		}
		let byStart: (Int, Int) -> Bool = { begins[$0] < begins[$1] }

		var rows: [WaterfallRow] = []
		rows.reserveCapacity(spans.count)
		var visited = Set<Int>()
		// Pushed in reverse so the earliest child pops first.
		var stack: [(index: Int, depth: Int)] = roots.sorted(by: byStart).reversed().map { ($0, 0) }
		// Spans in a parent cycle are reachable from no root; once the roots are
		// done, the earliest unvisited span starts a new walk so none are dropped.
		lazy var unrooted = spans.indices.sorted(by: byStart)
		var nextUnrooted = unrooted.startIndex
		while true {
			if stack.isEmpty {
				while nextUnrooted < unrooted.endIndex, visited.contains(unrooted[nextUnrooted]) {
					nextUnrooted += 1
				}
				guard nextUnrooted < unrooted.endIndex else { break }
				stack.append((unrooted[nextUnrooted], 0))
			}
			guard let (index, depth) = stack.popLast() else { break }
			// Guards the walk inside a cycle from revisiting a span.
			guard visited.insert(index).inserted else { continue }
			let span = spans[index]
			rows.append(
				WaterfallRow(
					span: span,
					depth: depth,
					offset: min(max(begins[index] / total, 0), 1),
					width: min(max(span.durationMs / total, 0.004), 1)
				)
			)
			for child in (children[index] ?? []).sorted(by: byStart).reversed() {
				stack.append((child, depth + 1))
			}
		}
		return rows
	}
}
