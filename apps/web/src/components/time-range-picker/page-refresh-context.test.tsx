// @vitest-environment jsdom

import { Atom, Registry, RegistryContext, Result } from "@/lib/effect-atom"
import { Effect } from "effect"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import {
	PageRefreshProvider,
	resolveRelativeRefreshRange,
	usePageRefreshContext,
} from "./page-refresh-context"

function createWrapper() {
	const registry = Registry.make()

	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

function makeCounterAtom(counter: { current: number }) {
	return Atom.make(
		Effect.sync(() => {
			counter.current += 1
			return counter.current
		}),
	)
}

function Controls() {
	const { reload } = usePageRefreshContext()

	return (
		<div>
			<button onClick={reload}>reload</button>
		</div>
	)
}

function Probe({ atom, label }: { atom: Atom.Atom<Result.Result<number, never>>; label: string }) {
	const value = useRefreshableAtomValue(atom)

	return (
		<div data-testid={label}>
			{Result.builder(value)
				.onSuccess((next) => String(next))
				.orElse(() => "initial")}
		</div>
	)
}

function Harness({
	timePreset,
	onRelativeRangeRefresh,
}: {
	timePreset?: string
	onRelativeRangeRefresh?: (range: { startTime: string; endTime: string; presetValue: string }) => void
}) {
	// Atoms must be created once per Harness instance, not on every render —
	// calling `makeCounterAtom` (which calls `Atom.make`) in the component body
	// would mint a fresh atom each render and lose its state. `useState`'s lazy
	// initializer runs exactly once per mount, giving each Harness stable atoms.
	const [atomA] = useState(() => makeCounterAtom({ current: 0 }))
	const [atomB] = useState(() => makeCounterAtom({ current: 0 }))

	return (
		<PageRefreshProvider timePreset={timePreset} onRelativeRangeRefresh={onRelativeRangeRefresh}>
			<Controls />
			<Probe atom={atomA} label="a" />
			<Probe atom={atomB} label="b" />
		</PageRefreshProvider>
	)
}

async function flushRefresh() {
	await act(async () => {
		await Promise.resolve()
	})
}

describe("page refresh controller", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"))
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("reloads multiple refresh-aware atoms on manual reload", async () => {
		render(<Harness />, { wrapper: createWrapper() })

		expect(screen.getByTestId("a").textContent).toBe("1")
		expect(screen.getByTestId("b").textContent).toBe("1")

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "reload" }))
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("2")
		expect(screen.getByTestId("b").textContent).toBe("2")
	})

	it("rebases relative presets on reload", () => {
		expect(resolveRelativeRefreshRange("15m")).toEqual({
			startTime: "2026-03-10 11:45:00",
			endTime: "2026-03-10 12:00:00",
			presetValue: "15m",
		})
	})

	it("does not invoke relative refresh callback for absolute ranges", async () => {
		const onRelativeRangeRefresh = vi.fn()

		render(<Harness onRelativeRangeRefresh={onRelativeRangeRefresh} />, {
			wrapper: createWrapper(),
		})

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "reload" }))
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("2")

		expect(onRelativeRangeRefresh).not.toHaveBeenCalled()
	})
})
