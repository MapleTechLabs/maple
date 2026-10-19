import { describe, expect, it } from "vitest"
import { makeCallLog, normalizePayload } from "./call-log.ts"

describe("call log normalization", () => {
	it("replaces v4 UUIDs, standalone or embedded, and keeps other ids", () => {
		expect(
			normalizePayload({
				id: "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b",
				path: "/dashboards/3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b/widgets",
				ruleId: "0199a002-0000-7000-8000-000000000001",
			}),
		).toEqual({
			id: "<random-uuid>",
			path: "/dashboards/<random-uuid>/widgets",
			ruleId: "0199a002-0000-7000-8000-000000000001",
		})
	})

	it("sorts keys at every depth so key order never reaches the diff", () => {
		const normalized = normalizePayload({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })
		expect(JSON.stringify(normalized)).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}')
	})

	it("returns a capture's calls once, then forgets them", () => {
		const log = makeCallLog()
		log.record("capture-1", "auth.session", { id: "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b" })
		log.recordUnmocked("capture-1", "queryEngine.listLogs (POST /internal/query-engine/list-logs)")
		log.record(null, "auth.session", {})
		expect(log.take("capture-1")).toEqual({
			calls: [{ tag: "auth.session", payload: { id: "<random-uuid>" } }],
			unmocked: ["queryEngine.listLogs (POST /internal/query-engine/list-logs)"],
		})
		expect(log.take("capture-1")).toEqual({ calls: [], unmocked: [] })
	})
})
