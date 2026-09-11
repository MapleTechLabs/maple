import { describe, expect, it } from "vitest"

import { bucketWidthLabel, smallMultipleBucketSeconds } from "./overview-buckets"

describe("smallMultipleBucketSeconds", () => {
	/** A window of `hours`, spelled the way the warehouse spells one. */
	const window = (hours: number) => {
		const endMs = Date.UTC(2026, 8, 11, 0, 0, 0)
		const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
		return [iso(endMs - hours * 3_600_000), iso(endMs)] as const
	}
	const widthOf = (hours: number) => smallMultipleBucketSeconds(...window(hours))

	it("cuts the usual windows at a width a reader recognises", () => {
		expect(widthOf(24)).toBe(3_600)
		expect(widthOf(24 * 7)).toBe(21_600)
		expect(widthOf(24 * 30)).toBe(86_400)
	})

	it("keeps every window inside the count a ~100px plot can separate", () => {
		for (const hours of [1, 6, 12, 24, 72, 24 * 7, 24 * 30]) {
			const points = (hours * 3_600) / widthOf(hours)
			expect(points).toBeLessThanOrEqual(36)
		}
	})

	it("stays on the five-minute grid the API's bucket bound needs", () => {
		for (const hours of [0.25, 1, 6, 12, 24, 72, 24 * 7, 24 * 30, 24 * 90]) {
			const width = widthOf(hours)
			expect(width % 300).toBe(0)
			expect(Number.isInteger(width)).toBe(true)
		}
	})

	it("floors at five minutes and tops out at a day", () => {
		expect(widthOf(0.25)).toBe(300)
		expect(widthOf(24 * 365)).toBe(86_400)
	})
})

describe("bucketWidthLabel", () => {
	it("names every width the grid's buckets are actually cut at", () => {
		// The ladder `smallMultipleBucketSeconds` snaps to, one unit each.
		const ladder = [300, 900, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400]
		expect(ladder.map(bucketWidthLabel)).toEqual(["5m", "15m", "30m", "1h", "3h", "6h", "12h", "1d"])
	})
})
