import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import type { InspectSpanOutput } from "@maple/domain/mcp-outputs"
import type { SpanDetailResult } from "@maple/query-engine/observability"
import { renderToolDoc } from "../../lib/tool-doc"
import { registerInspectSpanTool, spanDetailOutput } from "../inspect-span"
import type { McpToolRegistrar } from "../types"

/** The tool's render, fed the output through its schema the way the registry decodes it. */
let renderOutput: (output: typeof InspectSpanOutput.Type) => string = () =>
	expect.unreachable("inspect_span not registered")
const registrar: McpToolRegistrar = {
	define: (spec) => {
		if (spec.name !== "inspect_span") return
		renderOutput = (output) => renderToolDoc(spec.render(Schema.decodeUnknownSync(spec.output)(output)))
	},
}
registerInspectSpanTool(registrar)

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

const found = (overrides: Partial<SpanDetailResult>): SpanDetailResult => ({
	found: true,
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	spanAttributes: {},
	resourceAttributes: {},
	span: {
		spanName: "GET /orders",
		rawSpanName: "GET",
		serviceName: "api",
		spanKind: "Server",
		durationMs: 12,
		startTime: "2026-10-27 07:48:56.123",
		statusCode: "Unset",
		statusMessage: "",
	},
	...overrides,
})

const inspect = (result: SpanDetailResult) => {
	const output = spanDetailOutput(result)
	return { output, text: renderOutput(output) }
}

describe("inspect_span", () => {
	it("keeps a renamed Worker custom span's stored name, ids, status and Cloudflare context", () => {
		const { output, text } = inspect(
			found({
				// `updateName()` rewrites the stored SpanName; `setStatus()` sets the span status.
				span: {
					spanName: "probe.upstream",
					serviceName: "maple-api",
					spanKind: "Internal",
					durationMs: 0,
					startTime: "2026-10-27 07:48:56.123",
					statusCode: "Error",
					statusMessage: "Probe failed",
				},
				spanAttributes: {
					cpu_time_ms: "0",
					wall_time_ms: "0",
					"cloudflare.ray_id": "8d2f1a3b4c5d6e7f",
				},
				resourceAttributes: { "cloud.platform": "cloudflare.workers", "faas.name": "maple-api" },
			}),
		)
		expect(output).toMatchObject({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			spanName: "probe.upstream",
			statusCode: "Error",
			statusMessage: "Probe failed",
			platform: {
				_tag: "cloudflare",
				scriptName: "maple-api",
				cpuTimeMs: 0,
				wallTimeMs: 0,
				rayId: "8d2f1a3b4c5d6e7f",
			},
		})
		expect(output).not.toHaveProperty("rawSpanName")
		expect(text).toContain(`Span ${SPAN_ID} (trace ${TRACE_ID})`)
		expect(text).toContain("Name: probe.upstream")
		expect(text).toContain("Status: Error: Probe failed")
		expect(text).toContain("Cloudflare Worker")
		expect(text).toContain("CPU time: 0ms")
		expect(text).toContain("Wall time: 0ms")
		expect(text).toContain("a 0ms span may still have done CPU work")
		// The raw maps are still there in full.
		expect(text).toContain("`cloudflare.ray_id`: 8d2f1a3b4c5d6e7f")
		expect(text).toContain("`cloud.platform`: cloudflare.workers")
	})

	it("adds nothing for a span whose projected cloudflare.* keys are empty", () => {
		const { output, text } = inspect(
			found({
				spanAttributes: { "http.route": "/orders", "cloudflare.colo": "", "cloud.platform": "" },
			}),
		)
		expect(output).not.toHaveProperty("platform")
		expect(text).not.toContain("Cloudflare")
		expect(text).not.toContain("Workers limits")
	})

	it("shows the stored name beside a rewritten HTTP display name", () => {
		const { output, text } = inspect(found({}))
		expect(output).toMatchObject({ spanName: "GET /orders", rawSpanName: "GET" })
		expect(text).toContain("Name: GET /orders")
		expect(text).toContain("Stored name: GET")
	})

	it.each([
		["Unset", "", "Status: Unset"],
		["Ok", "", "Status: Ok"],
		["Error", "", "Status: Error"],
		["Error", "upstream 503", "Status: Error: upstream 503"],
	])("renders status %s with message %j as %j", (statusCode, statusMessage, line) => {
		const base = found({})
		const span = base.span === undefined ? expect.unreachable("fixture has a span") : base.span
		const { output, text } = inspect({ ...base, span: { ...span, statusCode, statusMessage } })
		expect(output.statusCode).toBe(statusCode)
		expect(text.split("\n")).toContain(line)
	})

	it("summarizes a non-Cloudflare FaaS span from OpenTelemetry semantics", () => {
		const { output, text } = inspect(
			found({
				resourceAttributes: {
					"cloud.provider": "aws",
					"cloud.platform": "aws_lambda",
					"cloud.region": "eu-west-1",
					"faas.name": "checkout",
				},
				spanAttributes: { "faas.coldstart": "true" },
			}),
		)
		expect(output.platform).toEqual({
			_tag: "cloud",
			provider: "aws",
			platform: "aws_lambda",
			region: "eu-west-1",
			functionName: "checkout",
			coldStart: true,
		})
		expect(text).toContain("Cloud platform")
		expect(text).toContain("Cold start: true")
		expect(text).not.toContain("Workers limits")
	})

	it("reports a missing span without span fields or a platform", () => {
		const { output, text } = inspect({
			found: false,
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			spanAttributes: {},
			resourceAttributes: {},
		})
		expect(output).toEqual({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			found: false,
			attributes: {},
			resourceAttributes: {},
		})
		expect(text).toContain(`Span ${SPAN_ID} not found in trace ${TRACE_ID}`)
		expect(text).not.toContain("Status:")
	})
})
