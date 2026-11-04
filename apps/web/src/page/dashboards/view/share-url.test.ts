import { describe, expect, test } from "vitest"
import { embedUrl, shareUrl } from "./share"

describe("share links", () => {
	test("carry the viewer's picked range so the recipient sees the same window", () => {
		expect(shareUrl("https://app.maple.dev", "tok", { type: "relative", value: "7d" })).toBe(
			"https://app.maple.dev/share/tok?range=7d",
		)
		expect(
			embedUrl("https://app.maple.dev", "tok", {
				type: "absolute",
				startTime: "2026-11-01 00:00:00",
				endTime: "2026-11-02 00:00:00",
			}),
		).toBe(
			"https://app.maple.dev/share/tok?embed=true&from=2026-11-01+00%3A00%3A00&to=2026-11-02+00%3A00%3A00",
		)
	})

	test("without a viewer pick they use the board's saved range", () => {
		expect(shareUrl("https://app.maple.dev", "tok", null)).toBe("https://app.maple.dev/share/tok")
		expect(embedUrl("https://app.maple.dev", "tok", null)).toBe(
			"https://app.maple.dev/share/tok?embed=true",
		)
	})
})
