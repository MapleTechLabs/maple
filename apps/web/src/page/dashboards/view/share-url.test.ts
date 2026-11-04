import { IsoDateTimeString } from "@maple/domain/http"
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
				startTime: IsoDateTimeString.make("2026-11-01T00:00:00.000Z"),
				endTime: IsoDateTimeString.make("2026-11-02T00:00:00.000Z"),
			}),
		).toBe(
			"https://app.maple.dev/share/tok?embed=true&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z",
		)
	})

	test("without a viewer pick they use the board's saved range", () => {
		expect(shareUrl("https://app.maple.dev", "tok", null)).toBe("https://app.maple.dev/share/tok")
		expect(embedUrl("https://app.maple.dev", "tok", null)).toBe(
			"https://app.maple.dev/share/tok?embed=true",
		)
	})
})
