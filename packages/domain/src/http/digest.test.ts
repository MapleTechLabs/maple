import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { UpsertDigestSubscriptionRequest } from "./digest"

const decode = Schema.decodeUnknownExit(UpsertDigestSubscriptionRequest)

describe("UpsertDigestSubscriptionRequest schedule fields", () => {
	it("accepts an IANA zone, a weekday and an hour in range", () => {
		const exit = decode({ dayOfWeek: 0, sendHour: 23, timezone: "Europe/Berlin" })
		expect(exit._tag).toBe("Success")
	})

	it("rejects zones the runtime cannot resolve and out of range days and hours", () => {
		for (const patch of [
			{ timezone: "Mars/Olympus_Mons" },
			{ dayOfWeek: 7 },
			{ dayOfWeek: 1.5 },
			{ sendHour: 24 },
			{ sendHour: -1 },
		]) {
			expect(decode(patch)._tag).toBe("Failure")
		}
	})
})
