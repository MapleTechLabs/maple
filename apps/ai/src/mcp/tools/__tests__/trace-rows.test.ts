import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { renderToolDoc } from "../../lib/tool-doc"
import { registerSearchTracesTool } from "../search-traces"
import { registerFindSlowTracesTool } from "../find-slow-traces"
import type { McpToolRegistrar } from "../types"

/** Each tool's render, fed an encoded output so the test needs no casts. */
const renders = new Map<string, (output: Schema.Json) => string>()
const registrar: McpToolRegistrar = {
	define: (spec) => {
		renders.set(spec.name, (output) =>
			renderToolDoc(spec.render(Schema.decodeUnknownSync(spec.output)(output))),
		)
	},
}
registerSearchTracesTool(registrar)
registerFindSlowTracesTool(registrar)

const render = (name: string, output: Schema.Json): string => {
	const fn = renders.get(name)
	if (fn === undefined) return expect.unreachable(`${name} not registered`)
	return fn(output)
}

const TRACE_ID = "bc3444f57e4e4b0c9d1e2f3a4b5c6d7e"
const SPAN_ID = "a1b2c3d4e5f60718"
const timeRange = { start: "2026-06-02 09:00:00", end: "2026-06-02 11:00:00" }
const row = {
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	rootSpanName: "http.server GET",
	durationMs: 812,
	services: ["api"],
	hasError: false,
	startTime: "2026-06-02 10:15:42.123456789",
}

describe("trace list rows", () => {
	it("search_traces prints full ids, the start time, and timestamp hints", () => {
		const text = render("search_traces", {
			timeRange,
			traces: [row],
			filters: { spanName: "GET", rootOnly: false },
			spanLevel: true,
		})
		expect(text).toContain(TRACE_ID)
		expect(text).toContain(SPAN_ID)
		expect(text).toContain("2026-06-02 10:15:42")
		expect(text).not.toContain("spanCount")
		expect(text).toContain(`inspect_trace trace_id="${TRACE_ID}" timestamp="2026-06-02 10:15:42"`)
		expect(text).toContain(
			`inspect_span trace_id="${TRACE_ID}" span_id="${SPAN_ID}" timestamp="2026-06-02 10:15:42"`,
		)
	})

	it("find_slow_traces carries the start time into the inspect_trace hint", () => {
		const text = render("find_slow_traces", { timeRange, traces: [row] })
		expect(text).toContain("| Start |")
		expect(text).toContain(`inspect_trace trace_id="${TRACE_ID}" timestamp="2026-06-02 10:15:42"`)
	})
})
