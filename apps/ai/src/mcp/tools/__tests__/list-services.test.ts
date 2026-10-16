/** list_services rendering: a real per-minute rate, and next calls aimed at the unhealthy services. */
import { Schema } from "effect"
import { ListServicesOutput } from "@maple/domain/mcp-outputs"
import { assert, describe, it } from "vitest"
import { renderToolDoc, type ToolDoc } from "../../lib/tool-doc"
import { registerListServicesTool } from "../list-services"
import type { McpToolRegistrar } from "../types"

let render: ((output: typeof ListServicesOutput.Encoded) => ToolDoc) | undefined
const registrar: McpToolRegistrar = {
	define: (spec) => {
		render = (output) => spec.render(Schema.decodeUnknownSync(spec.output)(output))
	},
}
registerListServicesTool(registrar)

const output = {
	// Six hours: 360 minutes.
	timeRange: { start: "2026-09-24 00:00:00", end: "2026-09-24 06:00:00" },
	total: 3,
	services: [
		{ name: "ingest", throughput: 1_440_000, errorRate: 0, p95Ms: 12 },
		{ name: "api", throughput: 36_000, errorRate: 0.05, p95Ms: 80 },
		{ name: "tiny-preview", throughput: 3, errorRate: 0, p95Ms: 5 },
	],
}

describe("list_services render", () => {
	it("shows the window total and a per-minute rate", () => {
		const text = renderToolDoc(render!(output))
		assert.include(text, "Req/min")
		assert.notInclude(text, "(rpm)")
		// 1,440,000 requests over 360 minutes.
		assert.match(text, /\| ingest \| 1,440,000 \| 4,000 \|/)
		assert.match(text, /\| tiny-preview \| 3 \| 0\.01 \|/)
	})

	it("points diagnose_service at the erroring service, not the smallest", () => {
		const next = render!(output).next ?? []
		const diagnosed = next
			.filter((call) => call.tool === "diagnose_service")
			.map((call) => call.args.service)
		assert.deepEqual(diagnosed, ["api"])
		const top = next.find((call) => call.tool === "get_service_top_operations")
		assert.equal(top?.args.service, "ingest")
	})
})
