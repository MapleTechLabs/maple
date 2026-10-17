import { describe, expect, test } from "vitest"
import { diffCallLogs } from "./behavior.ts"
import type { CallLogEntry } from "./contract.ts"

const call = (tag: string, payload: unknown = {}): CallLogEntry => ({ tag, payload })

describe("diffCallLogs ignore", () => {
	const legacy = [call("auth.session"), call("warehouse:abc", { q: 1 }), call("shape:alert_rules")]

	test("page-owned calls under an ignored prefix are not reported", () => {
		expect(
			diffCallLogs(legacy, [call("auth.session")], { ignore: ["warehouse:", "shape:alert_"] }),
		).toEqual([])
	})

	test("shell calls outside the ignored prefixes are still compared", () => {
		expect(diffCallLogs(legacy, [call("warehouse:abc", { q: 1 })], { ignore: ["shape:alert_"] })).toEqual(
			["auth.session not sent (1× in baseline)"],
		)
	})
})
