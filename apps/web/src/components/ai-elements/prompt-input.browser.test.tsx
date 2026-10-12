import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PromptInputSubmit } from "./prompt-input"

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

const loader = () => document.querySelector(".dmx-root")

describe("PromptInputSubmit", () => {
	it("shows a plain send affordance when idle", () => {
		render(<PromptInputSubmit status="ready" />)

		expect(screen.getByLabelText("Submit")).toBeTruthy()
		expect(loader()).toBeNull()
	})

	it("swaps to the loader while a turn is in flight", () => {
		render(<PromptInputSubmit status="streaming" />)

		expect(screen.getByLabelText("Sending")).toBeTruthy()
		expect(loader()).toBeTruthy()
	})

	it("cancels the turn rather than submitting the form when it can stop", () => {
		const onStop = vi.fn()
		render(<PromptInputSubmit status="streaming" onStop={onStop} />)

		const button = screen.getByLabelText("Stop generating")
		expect(button.getAttribute("type")).toBe("button")
		fireEvent.click(button)
		expect(onStop).toHaveBeenCalledOnce()
	})

	it("stays a submit control once the turn is done", () => {
		const onStop = vi.fn()
		render(<PromptInputSubmit status="ready" onStop={onStop} />)

		const button = screen.getByLabelText("Submit")
		expect(button.getAttribute("type")).toBe("submit")
		fireEvent.click(button)
		expect(onStop).not.toHaveBeenCalled()
	})
})
