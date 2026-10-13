// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode, Ref } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LogsInspectState, LogsStreamHandle } from "@/components/logs/logs-table"

const navigateSpy = vi.fn()
const reloadSpy = vi.fn()
const jumpSpy = vi.fn()
const providerProps = {
	timePreset: undefined as string | undefined,
	onRelativeRangeRefresh: undefined as unknown,
	autoRefreshMs: undefined as number | undefined,
	autoRefreshPaused: undefined as boolean | undefined,
}
const tableProps = {
	onInspectingChange: undefined as ((state: LogsInspectState) => void) | undefined,
}

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")
	return {
		...actual,
		useNavigate: () => navigateSpy,
	}
})

vi.mock("@/components/layout/dashboard-layout", () => {
	// Pass-through shell: every region just renders its children, so a test can
	// assert on header actions and page body without the sidebar/router chrome.
	const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
	return {
		DashboardLayout: {
			Root: passthrough,
			Breadcrumbs: () => null,
			Body: passthrough,
			Filters: passthrough,
			Content: passthrough,
			Sticky: passthrough,
			Header: passthrough,
			Scroll: passthrough,
			Fill: passthrough,
			RightPanel: passthrough,
			Title: passthrough,
			Description: passthrough,
		},
	}
})

vi.mock("@/components/logs/logs-table", () => ({
	LogsTable: ({
		onInspectingChange,
		streamRef,
	}: {
		onInspectingChange?: (state: LogsInspectState) => void
		streamRef?: Ref<LogsStreamHandle>
	}) => {
		tableProps.onInspectingChange = onInspectingChange
		if (typeof streamRef === "function") streamRef({ jumpToLatest: jumpSpy })
		else if (streamRef) streamRef.current = { jumpToLatest: jumpSpy }
		return <div>logs-table</div>
	},
}))

vi.mock("@/components/logs/logs-volume-chart", () => ({
	LogsVolumeChart: () => <div>logs-volume-chart</div>,
}))

vi.mock("@/components/logs/logs-filter-sidebar", () => ({
	LogsFilterSidebar: () => <div>logs-filter-sidebar</div>,
}))

vi.mock("@/components/time-range-picker/page-refresh-context", () => ({
	PageRefreshProvider: ({
		children,
		timePreset,
		onRelativeRangeRefresh,
		autoRefreshMs,
		autoRefreshPaused,
	}: {
		children: ReactNode
		timePreset?: string
		onRelativeRangeRefresh?: unknown
		autoRefreshMs?: number
		autoRefreshPaused?: boolean
	}) => {
		providerProps.timePreset = timePreset
		providerProps.onRelativeRangeRefresh = onRelativeRangeRefresh
		providerProps.autoRefreshMs = autoRefreshMs
		providerProps.autoRefreshPaused = autoRefreshPaused
		return <>{children}</>
	},
	usePageRefreshContext: () => ({ reload: reloadSpy, isReloading: false }),
}))

vi.mock("@/components/time-range-picker/time-range-header-controls", () => ({
	resolveSearchPreset: (search: { timePreset?: string; startTime?: string }, defaultPreset: string) =>
		search.timePreset ?? (search.startTime ? undefined : defaultPreset),
	TimeRangeHeaderControls: ({ reloadControls }: { reloadControls?: ReactNode }) => (
		<div>
			time-range-header-controls
			{reloadControls ?? <button type="button">plain-reload</button>}
		</div>
	),
}))

import * as LogsRoute from "./logs"
import { component as LogsPage } from "./logs?tsr-split=component"

const BASE_SEARCH = {
	services: undefined,
	severities: undefined,
	search: undefined,
	startTime: undefined,
	endTime: undefined,
	timePreset: undefined,
}

function mockSearch(search: Partial<LogsRoute.LogsSearchParams>) {
	vi.spyOn(LogsRoute.Route, "useSearch").mockReturnValue({ ...BASE_SEARCH, ...search })
}

const report = (state: LogsInspectState) => act(() => tableProps.onInspectingChange?.(state))

describe("LogsPage live refresh scope", () => {
	beforeEach(() => {
		navigateSpy.mockReset()
		reloadSpy.mockReset()
		jumpSpy.mockReset()
		providerProps.timePreset = undefined
		providerProps.onRelativeRangeRefresh = undefined
		providerProps.autoRefreshMs = undefined
		providerProps.autoRefreshPaused = undefined
		tableProps.onInspectingChange = undefined
		mockSearch({})
	})

	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
	})

	it("does not attach route-level relative refresh rebasing", () => {
		render(<LogsPage />)

		expect(providerProps.timePreset).toBe("12h")
		expect(providerProps.onRelativeRangeRefresh).toBeUndefined()
	})

	it("stays manual until `?refresh=` asks for a cadence", () => {
		render(<LogsPage />)

		expect(providerProps.autoRefreshMs).toBe(0)
		expect(screen.getByRole("button", { name: "Auto-refresh off" })).toBeDefined()
	})

	it("tails at the URL's cadence", () => {
		mockSearch({ refresh: 10 })
		render(<LogsPage />)

		expect(providerProps.autoRefreshMs).toBe(10_000)
		expect(screen.getByRole("button", { name: "Auto-refresh every 10s" })).toBeDefined()
	})

	it("writes the chosen cadence to the URL", () => {
		render(<LogsPage />)

		fireEvent.click(screen.getByRole("button", { name: "Auto-refresh off" }))
		fireEvent.click(screen.getByRole("menuitemradio", { name: "5s" }))

		expect(navigateSpy).toHaveBeenCalledTimes(1)
		const [{ replace, search }] = navigateSpy.mock.calls[0]
		expect(replace).toBe(true)
		expect(search({ timePreset: "1h" })).toEqual({ timePreset: "1h", refresh: 5 })
	})

	// A fixed window has nothing new to tail, so there is no cadence to offer.
	it("hides the cadence on a custom range", () => {
		mockSearch({ refresh: 10, startTime: "2026-10-08 10:00:00", endTime: "2026-10-08 11:00:00" })
		render(<LogsPage />)

		expect(providerProps.autoRefreshMs).toBe(0)
		expect(screen.queryByRole("button", { name: /Auto-refresh/ })).toBeNull()
		expect(screen.getByRole("button", { name: "plain-reload" })).toBeDefined()
	})

	it("pauses while the stream is being inspected, and says so", () => {
		mockSearch({ refresh: 10 })
		render(<LogsPage />)
		expect(providerProps.autoRefreshPaused).toBe(false)
		expect(screen.queryByText("Paused while you inspect")).toBeNull()

		report({ inspecting: true, scrolledAway: false })
		expect(providerProps.autoRefreshPaused).toBe(true)
		expect(screen.getByText("Paused while you inspect")).toBeDefined()
		// Hover or an expanded row is undone by the reader; only scroll gets a jump.
		expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()

		report({ inspecting: false, scrolledAway: false })
		expect(providerProps.autoRefreshPaused).toBe(false)
		expect(screen.queryByText("Paused while you inspect")).toBeNull()
	})

	it("offers jump to latest when scrolled away, which scrolls back and reloads", () => {
		mockSearch({ refresh: 10 })
		render(<LogsPage />)

		report({ inspecting: true, scrolledAway: true })
		fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }))

		expect(jumpSpy).toHaveBeenCalledTimes(1)
		expect(reloadSpy).toHaveBeenCalledTimes(1)
	})

	it("shows no paused note when auto-refresh is off", () => {
		render(<LogsPage />)

		report({ inspecting: true, scrolledAway: true })
		expect(screen.queryByText("Paused while you inspect")).toBeNull()
		expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()
	})
})
