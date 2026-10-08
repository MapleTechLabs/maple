// TEST-SEAM: rows render a router `Link` for trace ids; this focused test has no router.

import { Registry, RegistryContext } from "@/lib/effect-atom"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef, type ReactNode, type Ref } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Log } from "@/api/warehouse/logs"
import { buildLogsLabFixture } from "@/lab/logs-fixture"

import { LogsTableView, type LogsInspectState, type LogsStreamHandle } from "./logs-table"

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")
	return {
		...actual,
		Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
			<span className={className}>{children}</span>
		),
	}
})

const LOGS = buildLogsLabFixture(Date.UTC(2026, 9, 8, 14, 32, 10, 482), 120)

function View({
	logs = LOGS,
	onInspectingChange,
	streamRef,
}: {
	logs?: Log[]
	onInspectingChange?: (state: LogsInspectState) => void
	streamRef?: Ref<LogsStreamHandle>
}) {
	return (
		<div style={{ height: 400, display: "flex", flexDirection: "column" }}>
			<LogsTableView
				allData={logs}
				isFetchingNextPage={false}
				hasNextPage={false}
				isCapped={false}
				fetchNextPage={() => {}}
				waiting={false}
				wrap={false}
				density="compact"
				pinnedColumns={[]}
				embedded
				onInspectingChange={onInspectingChange}
				streamRef={streamRef}
			/>
		</div>
	)
}

function renderView(props: Parameters<typeof View>[0] = {}) {
	const registry = Registry.make()
	const wrapper = ({ children }: { children: ReactNode }) => (
		<RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	)
	return render(<View {...props} />, { wrapper })
}

const scroller = () => {
	const parent = screen.getByRole("log").parentElement
	expect(parent).not.toBeNull()
	const el = parent ?? document.body
	// No Tailwind in the test page, so give the scroller the overflow its classes would.
	el.style.overflowY = "auto"
	el.style.height = "300px"
	return el
}

const latest = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0]

afterEach(cleanup)

describe("LogsTableView inspect signal", () => {
	it("renders without a listener, as embedded lists use it", () => {
		renderView()
		fireEvent.pointerEnter(scroller())
		expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0)
	})

	it("holds while the pointer is over the stream", () => {
		const onChange = vi.fn()
		renderView({ onInspectingChange: onChange })

		fireEvent.pointerEnter(scroller())
		expect(latest(onChange)).toEqual({ inspecting: true, scrolledAway: false })

		fireEvent.pointerLeave(scroller())
		expect(latest(onChange)).toEqual({ inspecting: false, scrolledAway: false })
	})

	it("holds while a row is expanded, and releases when it collapses", () => {
		const onChange = vi.fn()
		renderView({ onInspectingChange: onChange })

		const [expand] = screen.getAllByRole("button", { name: "Expand log" })
		fireEvent.click(expand)
		expect(latest(onChange)).toEqual({ inspecting: true, scrolledAway: false })

		fireEvent.click(screen.getByRole("button", { name: "Collapse log" }))
		expect(latest(onChange)).toEqual({ inspecting: false, scrolledAway: false })
	})

	it("holds while scrolled down, and jump to latest scrolls back and releases", () => {
		const onChange = vi.fn()
		const streamRef = createRef<LogsStreamHandle>()
		renderView({ onInspectingChange: onChange, streamRef })

		const el = scroller()
		el.scrollTop = 600
		fireEvent.scroll(el)
		expect(latest(onChange)).toEqual({ inspecting: true, scrolledAway: true })

		act(() => streamRef.current?.jumpToLatest())
		expect(el.scrollTop).toBe(0)
		expect(latest(onChange)).toEqual({ inspecting: false, scrolledAway: false })
	})

	it("reports each transition once, not once per scroll frame", () => {
		const onChange = vi.fn()
		renderView({ onInspectingChange: onChange })

		const el = scroller()
		for (const top of [100, 200, 300]) {
			el.scrollTop = top
			fireEvent.scroll(el)
		}
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	// Rows are index-keyed: a refresh that prepends a row must not leave the
	// expansion on whichever log slid into the expanded slot.
	it("drops expansion when a refresh brings new rows to the top", () => {
		const registry = Registry.make()
		const wrapper = ({ children }: { children: ReactNode }) => (
			<RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
		)
		const onChange = vi.fn()
		const { rerender } = render(<View onInspectingChange={onChange} />, { wrapper })

		const [expand] = screen.getAllByRole("button", { name: "Expand log" })
		fireEvent.click(expand)
		expect(screen.getAllByRole("button", { name: "Collapse log" })).toHaveLength(1)
		expect(latest(onChange)).toEqual({ inspecting: true, scrolledAway: false })

		const fresh = buildLogsLabFixture(Date.UTC(2026, 9, 8, 14, 33, 0, 0), 121)
		rerender(<View logs={fresh} onInspectingChange={onChange} />)
		expect(screen.queryAllByRole("button", { name: "Collapse log" })).toHaveLength(0)
		// And the page is told, so a reload under an expanded row never leaves the tail stuck.
		expect(latest(onChange)).toEqual({ inspecting: false, scrolledAway: false })
	})
})
