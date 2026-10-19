import type { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { diffCallLogs } from "./behavior.ts"
import type { CallLogEntry } from "./contract.ts"

const call = (tag: string, payload: Schema.Json = {}): CallLogEntry => ({ tag, payload })

describe("diffCallLogs ignore", () => {
	const legacy = [
		call("integrations.cloudflareStatus"),
		call("warehouse:abc", { q: 1 }),
		call("shape:alert_rules"),
	]

	test("page-owned calls under an ignored prefix are not reported", () => {
		expect(
			diffCallLogs(legacy, [call("integrations.cloudflareStatus")], {
				ignore: ["warehouse:", "shape:alert_"],
			}),
		).toEqual([])
	})

	test("shell calls outside the ignored prefixes are still compared", () => {
		expect(diffCallLogs(legacy, [call("warehouse:abc", { q: 1 })], { ignore: ["shape:alert_"] })).toEqual(
			["integrations.cloudflareStatus not sent (1× in baseline)"],
		)
	})
})

describe("diffCallLogs app-minted ids", () => {
	const write = (id: string) =>
		call("dashboards.update", { body: { widgets: [{ id, title: "Total Logs" }] } })

	test("widget ids minted from the clock and a random suffix compare equal", () => {
		expect(diffCallLogs([write("1790856000000-k3j9x2a")], [write("1790856000000-p0q8r1s")])).toEqual([])
	})

	test("a fixture widget id is still compared", () => {
		expect(diffCallLogs([write("total-logs")], [write("total-errors")])).toEqual([
			"dashboards.update payload differs at .body.widgets[0].id",
		])
	})
})
