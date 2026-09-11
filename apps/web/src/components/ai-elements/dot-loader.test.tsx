// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DotLoader } from "./dot-loader"

afterEach(() => {
	cleanup()
})

/**
 * jsdom ships no `matchMedia`, and the dot-matrix loader asks it whether motion is welcome.
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
 * The animation a loader draws lives in the class names on its dots, and its footprint lives in
 * the matrix's own width and height, so together they identify what was rendered without
 * reaching into the component's geometry constants.
 */
const signature = (root: Element) => ({
	dots: [...root.querySelectorAll(".dmx-dot")]
		.map((dot) => dot.className)
		.sort()
		.join("|"),
	box: (root as HTMLElement).style.cssText.match(/width: \d+px; height: \d+px/)?.[0],
})

describe("DotLoader", () => {
	it("draws the same animation at the same size everywhere it is used", () => {
		const { container } = render(
			<>
				<DotLoader />
				<DotLoader label="Working" color="var(--primary)" />
				<DotLoader className="opacity-0" />
			</>,
		)

		const drawn = [...container.querySelectorAll(".dmx-root")].map(signature)
		expect(drawn).toHaveLength(3)
		for (const one of drawn) {
			expect(one).toEqual(drawn[0])
		}
	})

	it("fills the 14px box its settled-state icons are drawn in", () => {
		const { container } = render(<DotLoader />)

		expect(signature(container.querySelector(".dmx-root")!).box).toBe("width: 14px; height: 14px")
	})

	it("stays out of the accessibility tree unless it is given a name of its own", () => {
		const { container, rerender } = render(<DotLoader />)
		expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true")

		rerender(<DotLoader label="Working" />)
		expect(container.firstElementChild?.getAttribute("aria-hidden")).toBeNull()
		expect(container.querySelector('[aria-label="Working"]')).toBeTruthy()
	})
})
