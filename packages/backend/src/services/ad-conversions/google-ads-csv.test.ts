import { describe, expect, it } from "vitest"
import { buildGoogleAdsConversionsCsv, formatConversionTime } from "./google-ads-csv"

describe("buildGoogleAdsConversionsCsv", () => {
	it("writes the click conversion template with gclid rows only", () => {
		expect(
			buildGoogleAdsConversionsCsv([
				{ conversion: "signup", clickType: "gclid", clickId: "abc", convertedAt: 1_764_000_000_000 },
				{ conversion: "signup", clickType: "gbraid", clickId: "ios", convertedAt: 1_764_000_000_000 },
				{
					conversion: "activated",
					clickType: "gclid",
					clickId: "abc",
					convertedAt: 1_764_086_400_500,
				},
			]),
		).toBe(
			"Parameters:TimeZone=+0000\n" +
				"Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency\n" +
				"abc,Sign-up (server),2025-11-24 16:00:00+0000,,\n" +
				"abc,Activated (server),2025-11-25 16:00:00+0000,,\n",
		)
	})

	it("is just the header when there is nothing to report", () => {
		expect(buildGoogleAdsConversionsCsv([])).toBe(
			"Parameters:TimeZone=+0000\nGoogle Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency\n",
		)
	})

	it("formats times in UTC with an explicit offset", () => {
		expect(formatConversionTime(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05+0000")
	})
})
