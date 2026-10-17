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
