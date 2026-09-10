import { describe, expect, it } from "vitest"

import { formatBucketLabel } from "../../lib/format"
import { bucketTimeScale, zonedTimeScale } from "./plot-scales"

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe("zonedTimeScale", () => {
	it("puts day ticks on the zone's midnights, not UTC's", () => {
		// Three days over Tokyo (+9): UTC midnights sit at 09:00 there.
		const start = new Date("2026-03-01T00:00:00Z")
		const end = new Date("2026-03-04T00:00:00Z")
		const scale = bucketTimeScale([start, end], "Asia/Tokyo")
		const ticks = scale.ticks(3).map((tick) => tick.toISOString())
		expect(ticks).toEqual(["2026-03-01T15:00:00.000Z", "2026-03-02T15:00:00.000Z", "2026-03-03T15:00:00.000Z"])
	})

	it("survives the renderer's copy()", () => {
		const scale = zonedTimeScale("America/New_York")()
			.domain([new Date("2026-07-01T00:00:00Z"), new Date("2026-07-03T00:00:00Z")])
			.copy()
		const ticks = scale.ticks(2).map((tick) => tick.toISOString())
		// EDT midnight is 04:00Z.
		expect(ticks).toEqual(["2026-07-01T04:00:00.000Z", "2026-07-02T04:00:00.000Z"])
	})

	it("keeps ticks inside the domain across a DST change", () => {
		// US spring forward: 2026-03-08 02:00 local.
		const start = new Date("2026-03-07T12:00:00Z")
		const end = new Date("2026-03-09T12:00:00Z")
		const ticks = bucketTimeScale([start, end], "America/New_York").ticks(8)
		for (const tick of ticks) {
			expect(tick.getTime()).toBeGreaterThanOrEqual(start.getTime())
			expect(tick.getTime()).toBeLessThanOrEqual(end.getTime())
		}
		// Every tick is a round hour on the New York clock.
		const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", minute: "2-digit" })
		for (const tick of ticks) expect(Number(clock.format(tick))).toBe(0)
	})

	it("is the plain local scale without a zone", () => {
		expect(zonedTimeScale(undefined)().domain([new Date(0), new Date(DAY)]).ticks(2)).toHaveLength(2)
	})
})

describe("formatBucketLabel with a zone", () => {
	it("labels a daily bucket with the zone's day", () => {
		// 2026-03-01T15:00Z is midnight on the 2nd in Tokyo.
		const label = formatBucketLabel(
			"2026-03-01T15:00:00Z",
			{ rangeMs: 7 * DAY, bucketSeconds: DAY / 1000, timeZone: "Asia/Tokyo" },
			"tick",
		)
		expect(label).toMatch(/Mar 2/)
	})

	it("prints the tooltip clock in the zone", () => {
		const label = formatBucketLabel(
			"2026-03-01 15:00:00",
			{ rangeMs: 6 * HOUR, bucketSeconds: 300, timeZone: "UTC" },
			"tooltip",
		)
		expect(label).toMatch(/3:00 PM|15:00/)
	})
})
