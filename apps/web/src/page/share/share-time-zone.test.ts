import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { Message } from "./message"
import type { Model, SharedDashboard } from "./model"
import { init, update } from "./update"

// 05:00 in Los Angeles and 21:00 in Tokyo, both on 2026-10-01.
const NOW = Date.parse("2026-10-01T12:00:00Z")
const LA = "America/Los_Angeles"
const TOKYO = "Asia/Tokyo"

const board = (savedRange: string): SharedDashboard => ({
	mode: "public",
	scope: "dashboard",
	embeddable: true,
	dashboard: {
		id: "dash_1",
		name: "Platform overview",
		timeRange: { type: "relative", value: savedRange },
		widgets: [],
		sections: [],
	},
})

/** The share page opened in a `pageTimeZone` page with `search`. */
const windowOf = (search: Model["search"], pageTimeZone: string, savedRange = "1h") =>
	Arr.reduce(
		[
			Message.CompletedResolveClock({ nowMs: NOW }),
			Message.CompletedResolveShare({
				token: "tok",
				resolve: { _tag: "Ready", share: board(savedRange) },
			}),
		],
		init({ token: "tok", search }).model,
		(model, message) => update(model, message, pageTimeZone).model,
	).window

describe("share link time zone", () => {
	test("today from Los Angeles opened in Tokyo covers the Los Angeles day", () => {
		expect(windowOf({ range: "today", tz: LA }, TOKYO)?.startTime).toBe("2026-10-01 07:00:00")
	})

	test.each(["1w", "7d"])("%s from Los Angeles opened in Tokyo starts at Los Angeles midnight", (range) => {
		expect(windowOf({ range, tz: LA }, TOKYO)?.startTime).toBe("2026-09-25 07:00:00")
	})

	test("a link without a zone resolves in the page's zone", () => {
		expect(windowOf({ range: "today" }, TOKYO)?.startTime).toBe("2026-09-30 15:00:00")
	})

	test("an unknown zone is ignored and the page's zone applies", () => {
		expect(windowOf({ range: "today", tz: "Mars/Olympus_Mons" }, TOKYO)?.startTime).toBe(
			"2026-09-30 15:00:00",
		)
	})

	test("the board's saved calendar range resolves in the link's zone", () => {
		expect(windowOf({ tz: LA }, TOKYO, "today")?.startTime).toBe("2026-10-01 07:00:00")
	})
})
