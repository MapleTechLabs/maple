import { describe, expect, it } from "vitest"

import { digestTimeZoneOptions, newDigestDraft, sameDigestDraft } from "./digest-preferences"

const base = {
	dayOfWeek: 1,
	sendHour: 9,
	timezone: "Europe/Berlin",
	namespaces: ["payments", "checkout"],
	environments: ["production"],
}

describe("sameDigestDraft", () => {
	it("ignores the order scope values were picked in", () => {
		expect(sameDigestDraft(base, { ...base, namespaces: ["checkout", "payments"] })).toBe(true)
	})

	it("sees a change to the day, hour, zone or scope", () => {
		expect(sameDigestDraft(base, { ...base, dayOfWeek: 0 })).toBe(false)
		expect(sameDigestDraft(base, { ...base, sendHour: 10 })).toBe(false)
		expect(sameDigestDraft(base, { ...base, timezone: "UTC" })).toBe(false)
		expect(sameDigestDraft(base, { ...base, environments: [] })).toBe(false)
	})
})

describe("digestTimeZoneOptions", () => {
	it("keeps the saved and browser zones selectable and puts UTC first", () => {
		const zones = digestTimeZoneOptions(["Europe/Berlin", "Asia/Tokyo"], "Etc/GMT+5", "America/Denver")
		expect(zones[0]).toBe("UTC")
		expect(zones).toEqual(["UTC", "America/Denver", "Asia/Tokyo", "Etc/GMT+5", "Europe/Berlin"])
	})

	it("lists each zone once", () => {
		const zones = digestTimeZoneOptions(["UTC", "Europe/Berlin"], "Europe/Berlin", "Europe/Berlin")
		expect(zones).toEqual(["UTC", "Europe/Berlin"])
	})
})

describe("newDigestDraft", () => {
	it("schedules a first-time subscriber in the browser's zone", () => {
		expect(newDigestDraft("America/Los_Angeles")).toEqual({
			dayOfWeek: 1,
			sendHour: 9,
			timezone: "America/Los_Angeles",
			namespaces: [],
			environments: [],
		})
	})

	it("falls back to UTC when the browser reports no zone", () => {
		expect(newDigestDraft(undefined).timezone).toBe("UTC")
		expect(newDigestDraft("").timezone).toBe("UTC")
	})
})
