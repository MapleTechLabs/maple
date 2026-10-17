import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useIntervalRefresh } from "./use-interval-refresh"

function Probe({
	refresh,
	enabled = true,
	catchUp,
}: {
	refresh: () => void
	enabled?: boolean
	catchUp?: boolean
}) {
	useIntervalRefresh(refresh, { intervalMs: 10_000, enabled, catchUp })
	return null
}

describe("useIntervalRefresh", () => {
	beforeEach(() => vi.useFakeTimers())

	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("polls only while visible and clears the interval on unmount", () => {
		let hidden = false
		vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
		const refresh = vi.fn()
		const view = render(<Probe refresh={refresh} />)

		act(() => vi.advanceTimersByTime(10_000))
		expect(refresh).toHaveBeenCalledTimes(1)

		hidden = true
		act(() => vi.advanceTimersByTime(20_000))
		expect(refresh).toHaveBeenCalledTimes(1)

		hidden = false
		act(() => vi.advanceTimersByTime(10_000))
		expect(refresh).toHaveBeenCalledTimes(2)

		view.unmount()
		act(() => vi.advanceTimersByTime(20_000))
		expect(refresh).toHaveBeenCalledTimes(2)
	})

	it("refreshes the moment a hidden tab returns only with catchUp", () => {
		let hidden = true
		vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
		const plain = vi.fn()
		const catching = vi.fn()
		const view = render(
			<>
				<Probe refresh={plain} />
				<Probe refresh={catching} catchUp />
			</>,
		)

		hidden = false
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"))
		})
		expect(plain).not.toHaveBeenCalled()
		expect(catching).toHaveBeenCalledTimes(1)

		// Going hidden is no reason to refresh.
		hidden = true
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"))
		})
		expect(catching).toHaveBeenCalledTimes(1)

		// The listener goes with the component.
		view.unmount()
		hidden = false
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"))
		})
		expect(catching).toHaveBeenCalledTimes(1)
	})

	it("replaces the timer when the refresh callback changes", () => {
		const firstRefresh = vi.fn()
		const secondRefresh = vi.fn()
		const view = render(<Probe refresh={firstRefresh} />)

		view.rerender(<Probe refresh={secondRefresh} />)
		act(() => vi.advanceTimersByTime(10_000))

		expect(firstRefresh).not.toHaveBeenCalled()
		expect(secondRefresh).toHaveBeenCalledTimes(1)
	})
})
