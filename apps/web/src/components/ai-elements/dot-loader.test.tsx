// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DOT_LOADER_VARIANT_COUNT, DotLoader } from "./dot-loader"

afterEach(() => {
	cleanup()
})

/**
 * jsdom ships no `matchMedia`, and the dot-matrix loaders ask it whether motion is welcome.
 * Answering "no preference" is the branch that actually animates, which is the one under test.
 */
vi.stubGlobal("matchMedia", (query: string) => ({
	matches: false,
	media: query,
	onchange: null,
	addEventListener: () => {},
	removeEventListener: () => {},
	addListener: () => {},
	removeListener: () => {},
	dispatchEvent: () => false,
}))

/**
 * The animation a loader draws lives in the class names on its dots, so the set of those names
 * identifies which variant was picked without reaching into the pool.
 */
const signature = (root: Element) =>
	[...root.querySelectorAll(".dmx-dot")]
		.map((dot) => dot.className)
		.sort()
		.join("|")

describe("DotLoader", () => {
	it("draws from a pool wide enough that the chat doesn't look like it has one loader", () => {
		expect(DOT_LOADER_VARIANT_COUNT).toBeGreaterThanOrEqual(12)
	})

	it("picks a different animation across mounts", () => {
		// 40 draws from a pool this size lands on at least a handful of distinct animations with
		// margin far beyond flakiness: the odds of fewer than three are astronomically small.
		const { container } = render(
			<>
				{Array.from({ length: 40 }, (_, i) => (
					<DotLoader key={i} />
				))}
			</>,
		)

		const drawn = new Set([...container.querySelectorAll(".dmx-root")].map(signature))
		expect(drawn.size).toBeGreaterThanOrEqual(3)
	})

	it("keeps its animation while it stays mounted", () => {
		const { container, rerender } = render(<DotLoader />)
		const first = signature(container.querySelector(".dmx-root")!)

		rerender(<DotLoader />)

		expect(signature(container.querySelector(".dmx-root")!)).toBe(first)
	})

	it("stays out of the accessibility tree unless it is given a name of its own", () => {
		const { container, rerender } = render(<DotLoader />)
		expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true")

		rerender(<DotLoader label="Working" />)
		expect(container.firstElementChild?.getAttribute("aria-hidden")).toBeNull()
		expect(container.querySelector('[aria-label="Working"]')).toBeTruthy()
	})
})
