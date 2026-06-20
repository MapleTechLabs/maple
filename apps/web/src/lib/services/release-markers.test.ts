import { describe, expect, it } from "vitest"

import { detectReleaseMarkers } from "./release-markers"

const point = (bucket: string, commitSha: string, count: number) => ({ bucket, commitSha, count })

describe("detectReleaseMarkers", () => {
	it("returns nothing for an empty timeline", () => {
		expect(detectReleaseMarkers([])).toEqual([])
	})

	it("returns nothing when only one SHA is present (no deploy to mark)", () => {
		expect(
			detectReleaseMarkers([point("00:00", "aaaaaaa000", 5), point("00:05", "aaaaaaa000", 8)]),
		).toEqual([])
	})

	it("marks every distinct SHA at the bucket it first appears in", () => {
		const markers = detectReleaseMarkers([
			point("00:00", "aaaaaaa000", 5),
			point("00:05", "aaaaaaa000", 4),
			point("00:05", "bbbbbbb111", 2),
			point("00:10", "ccccccc222", 1),
		])
		expect(markers.map((m) => m.commitSha)).toEqual(["aaaaaaa000", "bbbbbbb111", "ccccccc222"])
		expect(markers.map((m) => m.bucket)).toEqual(["00:00", "00:05", "00:10"])
		expect(markers.map((m) => m.label)).toEqual(["aaaaaaa", "bbbbbbb", "ccccccc"])
	})

	// Regression for the reported bug: a mid-sequence release that carries the most
	// spans AND lands in the first bucket of the window must still get a marker. The
	// old "dominant SHA / first bucket" heuristics hid exactly this one.
	it("marks a high-traffic release that is both the densest and the first-bucket SHA", () => {
		const dense = "4736deb564"
		const a = "98fb39d840"
		const b = "262ae718dd"
		const markers = detectReleaseMarkers([
			point("13:25", dense, 1),
			point("13:30", dense, 4), // dense has the most spans overall (5)
			point("13:30", a, 1),
			point("13:30", b, 1),
		])
		const shas = markers.map((m) => m.commitSha)
		expect(shas).toContain(dense)
		expect(shas).toContain(a)
		expect(shas).toContain(b)
		expect(shas).toHaveLength(3)
	})

	it("orders markers by first-appearance bucket regardless of input order", () => {
		const markers = detectReleaseMarkers([
			point("02:00", "ccccccc222", 1),
			point("00:00", "aaaaaaa000", 1),
			point("01:00", "bbbbbbb111", 1),
		])
		expect(markers.map((m) => m.bucket)).toEqual(["00:00", "01:00", "02:00"])
	})
})
