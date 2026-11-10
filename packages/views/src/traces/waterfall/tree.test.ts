import { SpanId, TraceId } from "@maple/domain"
import { Schema, Array as Arr, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import type { SpanNodeData } from "@maple/views/traces/trace-data"
import { flatTreeOf } from "./tree"

const traceId = Schema.decodeSync(TraceId)("6843a8853182b32339b2dd5120d423f2")

const node = (id: string, depth: number, children: ReadonlyArray<SpanNodeData> = []): SpanNodeData => ({
	traceId,
	spanId: Schema.decodeSync(SpanId)(Str.padEnd(16, "0")(id)),
	parentSpanId: "",
	spanName: `span ${id}`,
	serviceName: "storefront",
	spanKind: "Server",
	durationMs: 10,
	startTime: "2026-10-01T11:43:32.411Z",
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
	children,
	depth,
})

const idOf = (id: string) => Str.padEnd(16, "0")(id)

/** r → (a → (c, d), b → e) */
const roots = [node("r", 0, [node("a", 1, [node("c", 2), node("d", 2)]), node("b", 1, [node("e", 2)])])]

describe("waterfall tree", () => {
	test("rows are depth-first, skip collapsed subtrees and carry their ancestor rails", () => {
		const flat = flatTreeOf(roots, [idOf("r"), idOf("a")])
		expect(
			Arr.map(flat.rows, (row) => ({
				id: row.node.spanId,
				rails: row.rails,
				isLast: row.isLast,
				parent: row.parent?.spanId ?? null,
			})),
		).toEqual([
			{ id: idOf("r"), rails: [], isLast: true, parent: null },
			{ id: idOf("a"), rails: [], isLast: false, parent: idOf("r") },
			{ id: idOf("c"), rails: [true], isLast: false, parent: idOf("a") },
			{ id: idOf("d"), rails: [true], isLast: true, parent: idOf("a") },
			{ id: idOf("b"), rails: [], isLast: true, parent: idOf("r") },
		])
		expect(flat.keys).toBe(Arr.join([idOf("r"), idOf("a"), idOf("c"), idOf("d"), idOf("b")], " "))
	})

	test("the same tree and expansion reuse one result; a new expansion lays out again", () => {
		const expanded = [idOf("r")]
		const first = flatTreeOf(roots, expanded)
		expect(flatTreeOf(roots, expanded)).toBe(first)
		const next = flatTreeOf(roots, [...expanded, idOf("b")])
		expect(next).not.toBe(first)
		expect(Arr.map(next.rows, (row) => row.node.spanId)).toEqual([
			idOf("r"),
			idOf("a"),
			idOf("b"),
			idOf("e"),
		])
	})
})
