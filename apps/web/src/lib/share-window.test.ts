import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { presetLabel } from "@/lib/time-utils"
import { resolveShareWindow } from "./share-window"

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const stored = { type: "relative", value: "12h" }

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe("resolveShareWindow", () => {
	it("uses the board's own range when the URL sets nothing", () => {
		const window = resolveShareWindow({}, stored, { snap: false })
		expect(window).toEqual({
			timeRange: { startTime: "2026-09-17 00:00:00", endTime: "2026-09-17 12:00:00" },
			label: presetLabel("12h"),
		})
	})

	it("lets ?range= override the board's range", () => {
		const window = resolveShareWindow({ range: "7d" }, stored, { snap: false })
		// The same grammar the dashboard's own picker uses, day-aligned and all.
		expect(window).toEqual({
			timeRange: resolveTimeRangeWindow({ type: "relative", value: "7d" }, { snap: false }),
			label: presetLabel("7d"),
		})
		expect(window?.timeRange.endTime).toBe("2026-09-17 12:00:00")
	})

	it("ignores a ?range= it cannot read rather than showing a different window", () => {
		expect(resolveShareWindow({ range: "seven-days" }, stored, { snap: false })).toEqual(
			resolveShareWindow({}, stored, { snap: false }),
		)
	})

	it("lets an absolute ?from/?to win over ?range=", () => {
		const window = resolveShareWindow(
			{ from: "2026-09-01 00:00:00", to: "2026-09-02 00:00:00", range: "7d" },
			stored,
		)
		expect(window?.timeRange).toEqual({
			startTime: "2026-09-01 00:00:00",
			endTime: "2026-09-02 00:00:00",
		})
	})

	it("falls back to the last hour when the board stores nothing usable", () => {
		const window = resolveShareWindow({}, undefined, { snap: false })
		expect(window).toEqual({
			timeRange: { startTime: "2026-09-17 11:00:00", endTime: "2026-09-17 12:00:00" },
			label: presetLabel("1h"),
		})
	})
})
