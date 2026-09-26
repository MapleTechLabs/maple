import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useTimeWindow } from "./use-time-window"

describe("useTimeWindow", () => {
	afterEach(() => vi.useRealTimers())

	it("keeps one window across filter changes and moves only on advance", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-30T14:05:00Z"))
		const { result, rerender } = renderHook(
			({ range, severity }) => ({ severity, ...useTimeWindow(range) }),
			{ initialProps: { range: "1h", severity: undefined as string | undefined } },
		)

		expect(result.current.bounds.startTime).toBe("2026-07-30 13:05:00")

		vi.setSystemTime(new Date("2026-07-30T16:05:00Z"))
		rerender({ range: "1h", severity: "ERROR" })
		// A filter change alone must not re-anchor (it would re-key every facet).
		expect(result.current.bounds.startTime).toBe("2026-07-30 13:05:00")

		act(() => {
			expect(result.current.advance()).toBe(true)
		})
		expect(result.current.severity).toBe("ERROR")
		expect(result.current.bounds).toEqual({
			startTime: "2026-07-30 15:05:00",
			endTime: "2026-07-30 17:05:00",
		})
	})

	it("snaps the anchor to the minute so a same-minute refresh reports no move", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-30T14:05:10Z"))
		const { result } = renderHook(() => useTimeWindow("1h"))
		expect(result.current.bounds.startTime).toBe("2026-07-30 13:05:00")

		vi.setSystemTime(new Date("2026-07-30T14:05:50Z"))
		act(() => {
			expect(result.current.advance()).toBe(false)
		})
		expect(result.current.bounds.startTime).toBe("2026-07-30 13:05:00")
	})
})
