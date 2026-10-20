import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { SpanId, TraceId } from "@maple/domain"
import type { SpanNode } from "@maple/ui/lib/types"

import { collectTraceErrors } from "./trace-errors"

const traceId = Schema.decodeSync(TraceId)("4bf92f3577b34da6a3ce929d0e0e4736")
const toSpanId = Schema.decodeSync(SpanId)
let nextId = 0
const T0 = Date.parse("2026-10-15T10:00:00.000Z")

function node(
	name: string,
	offsetMs: number,
	overrides: Partial<SpanNode> = {},
	children: Array<SpanNode> = [],
): SpanNode {
	return {
		traceId,
		spanId: toSpanId((++nextId).toString(16).padStart(16, "0")),
		parentSpanId: "",
		spanName: name,
		serviceName: "api",
		spanKind: "Internal",
		durationMs: 10,
		startTime: new Date(T0 + offsetMs).toISOString(),
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: {},
		resourceAttributes: {},
		children,
		depth: 0,
		...overrides,
	}
}

describe("collectTraceErrors", () => {
	it("picks the innermost failed span as the origin, not the parent it propagated to", () => {
		const errors = collectTraceErrors([
			node("root", 0, { statusCode: "Error" }, [
				node("ok-child", 1),
				node("db", 2, { statusCode: "Error", statusMessage: "deadlock" }),
			]),
		])
		expect(errors.spans.map((s) => s.spanName)).toEqual(["root", "db"])
		expect(errors.origin?.spanName).toBe("db")
	})

	it("picks the earliest origin when sibling branches fail independently", () => {
		const errors = collectTraceErrors([
			node("root", 0, {}, [
				node("late", 8, { statusCode: "Error" }),
				node("early", 3, { statusCode: "Error" }),
			]),
		])
		expect(errors.origin?.spanName).toBe("early")
	})

	it("counts a 5xx response as a failure but not a 4xx", () => {
		const errors = collectTraceErrors([
			node(
				"root",
				0,
				{
					spanKind: "Server",
					spanName: "GET /a",
					spanAttributes: { "http.response.status_code": "503" },
				},
				[
					node("child", 1, {
						spanKind: "Client",
						spanName: "GET /b",
						spanAttributes: { "http.response.status_code": "404" },
					}),
				],
			),
		])
		expect(errors.spans.map((s) => s.spanName)).toEqual(["GET /a"])
	})

	it("counts a 5xx on a span whose name carries no HTTP method", () => {
		const errors = collectTraceErrors([
			node("HTTP GET /x", 0, { spanKind: "Server", spanAttributes: { "http.status_code": "502" } }),
		])
		expect(errors.origin?.spanName).toBe("HTTP GET /x")
	})

	it("reports no origin for a clean trace and skips missing-span placeholders", () => {
		const errors = collectTraceErrors([
			node("gap", 0, { isMissing: true, statusCode: "Error" }, [node("a", 1)]),
		])
		expect(errors.spans).toEqual([])
		expect(errors.origin).toBeUndefined()
	})
})
