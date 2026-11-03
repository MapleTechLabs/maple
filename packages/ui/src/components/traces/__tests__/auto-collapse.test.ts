import { describe, expect, it } from "vitest"

import { collectDescendantParentIds, computeCollapseOneLevel, computeExpandOneLevel } from "../auto-collapse"
import type { SpanNode } from "../../../lib/types"

/** Minimal SpanNode — these helpers only read spanId, depth and children. */
function node(spanId: string, depth: number, children: SpanNode[] = []): SpanNode {
	return {
		traceId: "t",
		spanId,
		parentSpanId: "",
		spanName: spanId,
		serviceName: "svc",
		spanKind: "Internal",
		durationMs: 1,
		startTime: "2026-01-01T00:00:00.000Z",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: {},
		resourceAttributes: {},
		children,
		depth,
	} as SpanNode
}

//  root (0)
//  ├── a (1) ── a1 (2) ── a1x (3)
//  └── b (1) ── b1 (2)          ← b1 is a leaf, so not a "parent"
const TREE = [
	node("root", 0, [node("a", 1, [node("a1", 2, [node("a1x", 3)])]), node("b", 1, [node("b1", 2)])]),
]

/** TREE's parents bucketed by depth, the shape the level-at-a-time helpers take. */
const BY_LEVEL = new Map([
	[0, new Set(["root"])],
	[1, new Set(["a", "b"])],
	[2, new Set(["a1"])],
])

describe("computeExpandOneLevel", () => {
	it("opens the shallowest level that still has a collapsed parent", () => {
		const step1 = computeExpandOneLevel(new Set(), BY_LEVEL)
		expect(step1).toEqual(new Set(["root"]))
		const step2 = computeExpandOneLevel(step1, BY_LEVEL)
		expect(step2).toEqual(new Set(["root", "a", "b"]))
		const step3 = computeExpandOneLevel(step2, BY_LEVEL)
		expect(step3).toEqual(new Set(["root", "a", "b", "a1"]))
	})

	it("expands a partially open level rather than skipping past it", () => {
		const next = computeExpandOneLevel(new Set(["root", "a"]), BY_LEVEL)
		expect(next).toEqual(new Set(["root", "a", "b"]))
	})

	it("returns the same set when everything is already open", () => {
		const all = new Set(["root", "a", "b", "a1"])
		expect(computeExpandOneLevel(all, BY_LEVEL)).toBe(all)
	})
})

describe("computeCollapseOneLevel", () => {
	it("closes the deepest expanded level first", () => {
		const all = new Set(["root", "a", "b", "a1"])
		const step1 = computeCollapseOneLevel(all, BY_LEVEL)
		expect(step1).toEqual(new Set(["root", "a", "b"]))
		const step2 = computeCollapseOneLevel(step1, BY_LEVEL)
		expect(step2).toEqual(new Set(["root"]))
		const step3 = computeCollapseOneLevel(step2, BY_LEVEL)
		expect(step3).toEqual(new Set())
	})

	it("returns the same set when everything is already closed", () => {
		const none = new Set<string>()
		expect(computeCollapseOneLevel(none, BY_LEVEL)).toBe(none)
	})

	it("round-trips with computeExpandOneLevel", () => {
		const all = new Set(["root", "a", "b", "a1"])
		expect(computeExpandOneLevel(computeCollapseOneLevel(all, BY_LEVEL), BY_LEVEL)).toEqual(all)
	})
})

describe("collectDescendantParentIds", () => {
	it("returns expandable descendants only, excluding the node itself", () => {
		expect(collectDescendantParentIds(TREE[0]).sort()).toEqual(["a", "a1", "b"])
	})

	it("returns nothing for a leaf", () => {
		expect(collectDescendantParentIds(node("leaf", 0))).toEqual([])
	})
})
