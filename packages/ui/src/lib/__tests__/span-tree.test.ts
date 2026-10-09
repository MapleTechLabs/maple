import { describe, expect, it } from "vitest"
import {
	buildSpanTree,
	buildTraceDetail,
	dedupeBySpanId,
	transformSpan,
	type SpanHierarchyRow,
} from "../span-tree"
import type { Span, SpanNode } from "../types"

function row(overrides: Partial<SpanHierarchyRow> & { spanId: string }): SpanHierarchyRow {
	return {
		traceId: "trace-1",
		parentSpanId: "",
		spanName: `span-${overrides.spanId}`,
		serviceName: "svc",
		spanKind: "SPAN_KIND_SERVER",
		durationMs: 10,
		startTime: "2026-06-10 12:00:00.000",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: "{}",
		resourceAttributes: "{}",
		...overrides,
	}
}

function span(overrides: Partial<SpanHierarchyRow> & { spanId: string }): Span {
	return transformSpan(row(overrides))
}

function flatten(nodes: SpanNode[], out: SpanNode[] = []): SpanNode[] {
	for (const node of nodes) {
		out.push(node)
		flatten(node.children, out)
	}
	return out
}

describe("dedupeBySpanId", () => {
	it("keeps the first occurrence of each spanId", () => {
		const spans = [
			span({ spanId: "a", spanName: "first" }),
			span({ spanId: "a", spanName: "second" }),
			span({ spanId: "b" }),
		]
		const deduped = dedupeBySpanId(spans)
		expect(deduped.map((s) => s.spanId)).toEqual(["a", "b"])
		expect(deduped[0].spanName).toBe("first")
	})
})

describe("buildSpanTree", () => {
	it("builds parent/child links with depth and start-time ordering", () => {
		const tree = buildSpanTree([
			span({ spanId: "root" }),
			span({ spanId: "late-child", parentSpanId: "root", startTime: "2026-06-10 12:00:02.000" }),
			span({ spanId: "early-child", parentSpanId: "root", startTime: "2026-06-10 12:00:01.000" }),
			span({ spanId: "grandchild", parentSpanId: "early-child" }),
		])

		expect(tree).toHaveLength(1)
		expect(tree[0].spanId).toBe("root")
		expect(tree[0].depth).toBe(0)
		expect(tree[0].children.map((c) => c.spanId)).toEqual(["early-child", "late-child"])
		expect(tree[0].children[0].depth).toBe(1)
		expect(tree[0].children[0].children[0].spanId).toBe("grandchild")
		expect(tree[0].children[0].children[0].depth).toBe(2)
	})

	it("links each span exactly once when the warehouse returns duplicate rows", () => {
		// At-least-once ingest delivery can hand us the same span multiple times.
		// Before deduping, the duplicate linked the same node into its parent's
		// children twice, repeating whole subtrees (and breaking the spanId-keyed
		// waterfall rows).
		const child = span({ spanId: "child", parentSpanId: "root" })
		const tree = buildSpanTree([
			span({ spanId: "root" }),
			child,
			{ ...child },
			{ ...child },
			span({ spanId: "grandchild", parentSpanId: "child" }),
		])

		expect(tree).toHaveLength(1)
		expect(tree[0].children).toHaveLength(1)
		expect(tree[0].children[0].children).toHaveLength(1)

		const ids = flatten(tree).map((n) => n.spanId)
		expect(ids).toEqual(["root", "child", "grandchild"])
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("collapses duplicate root spans to a single root", () => {
		const tree = buildSpanTree([span({ spanId: "root" }), span({ spanId: "root" })])
		expect(tree).toHaveLength(1)
	})

	it("treats a self-parenting span as a root instead of recursing forever", () => {
		const tree = buildSpanTree([span({ spanId: "weird", parentSpanId: "weird" })])
		expect(tree).toHaveLength(1)
		expect(tree[0].spanId).toBe("weird")
		expect(tree[0].children).toHaveLength(0)
	})

	it("groups a rooted trace's orphans under a missing-span placeholder", () => {
		const tree = buildSpanTree([
			span({ spanId: "root" }),
			span({ spanId: "orphan-1", parentSpanId: "gone" }),
			span({ spanId: "orphan-2", parentSpanId: "gone" }),
		])

		expect(tree.map((n) => n.spanId)).toEqual(["root", "gone"])
		expect(tree[1].isMissing).toBe(true)
		expect(tree[1].children.map((c) => c.spanId)).toEqual(["orphan-1", "orphan-2"])
		expect(tree[1].children[0].depth).toBe(1)
	})

	it("puts the spans of a trace with no root at the top level, with no placeholder", () => {
		const tree = buildSpanTree([
			span({ spanId: "entry-b", parentSpanId: "proxy-2", startTime: "2026-01-01T00:00:01.000Z" }),
			span({ spanId: "entry-a", parentSpanId: "proxy-1", startTime: "2026-01-01T00:00:00.000Z" }),
			span({ spanId: "child", parentSpanId: "entry-a", startTime: "2026-01-01T00:00:00.500Z" }),
		])

		expect(tree.map((n) => n.spanId)).toEqual(["entry-a", "entry-b"])
		expect(tree.some((n) => n.isMissing)).toBe(false)
		expect(tree[0].depth).toBe(0)
		expect(tree[0].children.map((c) => c.spanId)).toEqual(["child"])
	})
})

describe("buildTraceDetail", () => {
	it("dedupes the flat span list and derives totals from unique spans", () => {
		const detail = buildTraceDetail([
			row({ spanId: "root", durationMs: 50 }),
			row({ spanId: "root", durationMs: 50 }),
			row({ spanId: "child", parentSpanId: "root", durationMs: 10, serviceName: "other" }),
		])

		expect(detail.spans.map((s) => s.spanId)).toEqual(["root", "child"])
		expect(detail.rootSpans).toHaveLength(1)
		expect(detail.rootSpans[0].children).toHaveLength(1)
		expect(detail.totalDurationMs).toBe(50)
		expect(detail.services).toEqual(["svc", "other"])
	})
})
