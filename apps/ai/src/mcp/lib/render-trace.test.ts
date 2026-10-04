import { describe, expect, it } from "vitest"
import { SpanId } from "@maple/domain"
import type { SpanNode } from "@maple/query-engine/observability"
import { Schema } from "effect"
import {
	buildTraceOverview,
	renderTraceOverview,
	type TraceOverviewInput,
	type TraceOverviewLog,
} from "./render-trace"
import { renderToolDoc } from "./tool-doc"

const decodeSpanId = Schema.decodeSync(SpanId)

function span(
	id: string,
	opts: Partial<Omit<SpanNode, "spanId" | "children">> & { children?: SpanNode[] } = {},
): SpanNode {
	return {
		spanId: decodeSpanId(id),
		parentSpanId: opts.parentSpanId ?? "",
		spanName: opts.spanName ?? id,
		...(opts.rawSpanName === undefined ? undefined : { rawSpanName: opts.rawSpanName }),
		serviceName: opts.serviceName ?? "svc",
		spanKind: opts.spanKind ?? "Internal",
		durationMs: opts.durationMs ?? 1,
		statusCode: opts.statusCode ?? "Unset",
		statusMessage: opts.statusMessage ?? "",
		attributes: opts.attributes ?? {},
		resourceAttributes: opts.resourceAttributes ?? {},
		children: opts.children ?? [],
	}
}

const base = {
	traceId: "trace-abc",
	serviceCount: 1,
	rootDurationMs: 100,
	logs: [] as TraceOverviewLog[],
}

/** The overview the handler builds, and the text the tool renders from it. */
const render = (input: TraceOverviewInput) => {
	const overview = buildTraceOverview(input)
	return { overview, text: renderToolDoc(renderTraceOverview(overview)) }
}

describe("renderTraceOverview", () => {
	it("renders every span with a copyable span id and no truncation note for small traces", () => {
		const spans = [span("root", { children: [span("child-1"), span("child-2")] })]
		const { text, overview } = render({ ...base, spanCount: 3, spans, budget: 100 })

		expect(overview.truncated).toBe(false)
		expect(text).not.toContain("Showing")
		expect(text).toContain("span=root")
		expect(text).toContain("span=child-1")
		expect(text).toContain("span=child-2")
	})

	it("bounds a large trace and emits a Showing N of M note + collapse markers", () => {
		const children = Array.from({ length: 20 }, (_, i) =>
			span(`b${i}`, { spanName: "batch", durationMs: 1 }),
		)
		const spans = [
			span("root", {
				durationMs: 100,
				spanKind: "Server",
				children: [span("hot", { durationMs: 90, children }), span("err", { statusCode: "Error" })],
			}),
		]
		const totalSpanCount = 1 + 1 + 20 + 1
		const { text, overview } = render({
			...base,
			spanCount: totalSpanCount,
			spans,
			budget: 5,
		})

		expect(overview.truncated).toBe(true)
		expect(text).toContain(`Showing ${overview.renderedSpanCount} of ${totalSpanCount} spans`)
		// The error span is always kept and labelled.
		expect(text).toContain("span=err")
		expect(text).toContain("[Error]")
		// Dropped children are summarised, not dumped.
		expect(text).toMatch(/… \+\d+ more spans/)
		// The rollup covers every span, not just the rendered ones.
		expect(overview.rollup?.find((r) => r.spanName === "batch")).toMatchObject({
			count: 20,
			totalDurationMs: 20,
		})
		expect(overview.rollup?.reduce((n, r) => n + r.count, 0)).toBe(totalSpanCount)
		expect(text).toContain(`Span names across all ${totalSpanCount} spans`)
	})

	it("shows the stored span name, resource attributes once per service, and unrecorded parent durations", () => {
		const resourceAttributes = { "service.version": "1.2.3" }
		const spans = [
			span("root", {
				spanName: "GET /users/:id",
				rawSpanName: "http.server GET",
				durationMs: 0,
				resourceAttributes,
				children: [span("child", { resourceAttributes, durationMs: 5 })],
			}),
		]
		const { text } = render({ ...base, spanCount: 2, spans, budget: 100 })
		expect(text).toContain('span_name="http.server GET", duration not recorded')
		expect(text.match(/service\.version=1\.2\.3/g)).toHaveLength(1)
		expect(text).toContain("`inspect_span` with a `span=` id lists every attribute")
	})

	it("says which window an empty read scanned", () => {
		const { text } = render({
			...base,
			spanCount: 0,
			spans: [],
			budget: 100,
			timestamp: "2026-06-02 10:00:00",
			scanned: { startTime: "2026-05-03 09:00:00", endTime: "2026-06-02 11:00:00", widened: true },
		})
		expect(text).toContain("scanned 2026-05-03 09:00:00 to 2026-06-02 11:00:00, widened")
	})

	it("renders related logs with a severity marker and span ref", () => {
		const spans = [span("root")]
		const logs: TraceOverviewLog[] = [
			{
				timestamp: "2026-06-02 10:00:00",
				severityText: "ERROR",
				serviceName: "api",
				body: "boom",
				spanId: "deadbeefcafef00d",
			},
			{
				timestamp: "2026-06-02 10:00:01",
				severityText: "info",
				serviceName: "api",
				body: "ok",
				spanId: "",
			},
		]
		const { text } = render({ ...base, spanCount: 1, spans, logs, budget: 100 })

		expect(text).toContain("Related Logs (2):")
		expect(text).toContain("● ") // ERROR marker
		expect(text).toContain("span=deadbeefcafef00d") // full span id, never a prefix
	})
})

describe("renderTraceOverview errorsOnly", () => {
	it("says which policy pruned the tree", () => {
		const spans = [
			span("root", {
				children: [span("ok"), span("bad", { statusCode: "Error", statusMessage: "boom" })],
			}),
		]
		const { text, overview } = render({
			...base,
			spanCount: 3,
			spans,
			budget: 100,
			options: { errorsOnly: true },
		})
		expect(overview.renderedSpanCount).toBe(2)
		expect(text).toContain("error spans and their ancestors only")
		expect(text).toContain("bad")
		expect(text).not.toContain("ok —")
	})
})
