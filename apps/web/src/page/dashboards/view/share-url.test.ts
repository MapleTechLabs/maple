import { IsoDateTimeString } from "@maple/domain/http"
import { describe, expect, test } from "vitest"
import { embedUrl, type ShareLinkRange, shareUrl } from "./share"

const LA = "America/Los_Angeles"
const ORIGIN = "https://app.maple.dev"
const relative = (value: string): ShareLinkRange["range"] => ({ type: "relative", value })
const paramsOf = (url: string) => Object.fromEntries(new URL(url).searchParams)

describe("share links", () => {
	test("carry the viewer's picked range so the recipient sees the same window", () => {
		expect(shareUrl(ORIGIN, "tok", { range: relative("6h"), timeZone: LA })).toBe(
			"https://app.maple.dev/share/tok?range=6h",
		)
		expect(
			embedUrl(ORIGIN, "tok", {
				range: {
					type: "absolute",
					startTime: IsoDateTimeString.make("2026-11-01T00:00:00.000Z"),
					endTime: IsoDateTimeString.make("2026-11-02T00:00:00.000Z"),
				},
				timeZone: LA,
			}),
		).toBe(
			"https://app.maple.dev/share/tok?embed=true&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z",
		)
	})

	test.each(["today", "1w", "7d", "1mo", "3mo"])(
		"a wall-clock range %s pins the creator's zone",
		(value) => {
			const link = { range: relative(value), timeZone: LA }
			expect(paramsOf(shareUrl(ORIGIN, "tok", link))).toEqual({ range: value, tz: LA })
			expect(paramsOf(embedUrl(ORIGIN, "tok", link))).toEqual({ embed: "true", range: value, tz: LA })
		},
	)

	test("an hour range is the same window in every zone, so it carries no zone", () => {
		expect(paramsOf(shareUrl(ORIGIN, "tok", { range: relative("1h"), timeZone: LA }))).toEqual({
			range: "1h",
		})
	})

	test("without a viewer pick they pin the creator's zone for whatever the board saves later", () => {
		const link = { range: null, timeZone: LA }
		expect(paramsOf(shareUrl(ORIGIN, "tok", link))).toEqual({ tz: LA })
		expect(paramsOf(embedUrl(ORIGIN, "tok", link))).toEqual({ embed: "true", tz: LA })
	})
})
