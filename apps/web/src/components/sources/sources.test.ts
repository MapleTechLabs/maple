import { V2Source } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { sourceSnippets } from "./snippets"
import { sourceStatus } from "./source-status"
import { orderSources } from "./sources-table"

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
		...overrides,
	})

describe("sourceStatus", () => {
	it("waits until the first request, then receives; paused and expired win over last data", () => {
		expect(sourceStatus(source({})).status).toBe("pending")
		expect(sourceStatus(source({ last_used_at: "2026-07-02T12:00:00.000Z" }))).toEqual({
			status: "healthy",
			lastDataAt: "2026-07-02T12:00:00.000Z",
		})
		const lastUsed = { last_used_at: "2026-07-02T12:00:00.000Z" }
		expect(sourceStatus(source({ ...lastUsed, status: "paused" })).status).toBe("paused")
		expect(sourceStatus(source({ ...lastUsed, status: "expired" })).status).toBe("expired")
	})
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
})
