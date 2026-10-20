import { V2Source, type V2SourceUsage } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { sourceSnippets } from "./snippets"
import { orderSources } from "./sources-table"
import { usageRows } from "./usage-chart"

const decodeSource = Schema.decodeUnknownSync(V2Source)
const source = (overrides: Record<string, unknown>) =>
	decodeSource({
		id: "src_aXunrkWtzvXSkw9Z2smcft",
		object: "source",
		name: "Checkout API",
		description: null,
		platform: "nodejs",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: null,
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: null,
		created_at: "2026-07-01T12:00:00.000Z",
		updated_at: "2026-07-01T12:00:00.000Z",
		health: { status: "pending", last_data_at: null, problem: null, resources: null },
		...overrides,
	})

describe("orderSources", () => {
	it("pins the default source first and keeps the rest in API order", () => {
		const a = source({ id: "src_aXunrkWtzvXSkw9Z2smcfa", name: "A" })
		const b = source({ id: "src_aXunrkWtzvXSkw9Z2smcfb", name: "B" })
		const fallback = source({ id: "src_aXunrkWtzvXSkw9Z2smcfc", is_default: true, key_prefix: null })
		expect(orderSources([a, fallback, b]).map((entry) => entry.name)).toEqual(["Checkout API", "A", "B"])
	})
})

describe("sourceSnippets", () => {
	it("puts the token in every snippet for the platform's own setup", () => {
		const token = "maple_src_secret"
		const helm = sourceSnippets("kubernetes", token, "Prod cluster")
		expect(helm.map((snippet) => snippet.id)).toEqual(["helm"])
		const node = sourceSnippets("nodejs", token, "Checkout API")
		expect(node.map((snippet) => snippet.id)).toEqual(["env", "sdk"])
		expect(node[0]?.code).toContain('OTEL_SERVICE_NAME="checkout-api"')
		expect([...helm, ...node].filter((snippet) => !snippet.code.includes(token))).toEqual([])
	})

	it("URL-encodes the space in the OTLP headers variable", () => {
		const [env] = sourceSnippets("nodejs", "maple_src_secret", "Checkout API")
		expect(env?.code).toContain('OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20maple_src_secret"')
	})
})

describe("usageRows", () => {
	const usage = (windowEnd: string, hours: ReadonlyArray<string>): V2SourceUsage => ({
		object: "source_usage",
		window_start: new Date(new Date(windowEnd).getTime() - 24 * 3_600_000).toISOString(),
		window_end: windowEnd,
		buckets: hours.map((hour) => ({ hour, spans: 5, logs: 1 })),
	})

	it("keeps an hour-aligned window inside its 24 hours", () => {
		const rows = usageRows(
			usage("2026-10-18T12:00:00.000Z", ["2026-10-17T12:00:00.000Z", "2026-10-18T11:00:00.000Z"]),
		)
		expect(rows).toHaveLength(24)
		expect(rows[0]).toEqual({ bucket: "2026-10-17T12:00:00.000Z", Spans: 5, Logs: 1 })
		expect(rows[23]).toEqual({ bucket: "2026-10-18T11:00:00.000Z", Spans: 5, Logs: 1 })
	})

	it("ends on the current partial hour mid-hour", () => {
		const rows = usageRows(usage("2026-10-18T12:30:00.000Z", []))
		expect(rows[23]).toEqual({ bucket: "2026-10-18T12:00:00.000Z", Spans: 0, Logs: 0 })
	})
})
