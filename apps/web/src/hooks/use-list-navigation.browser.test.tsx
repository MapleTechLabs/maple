import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useListNavigation, type ListNavigationOptions } from "./use-list-navigation"

function Probe(props: ListNavigationOptions<string>) {
	const { focusedId } = useListNavigation(props)
	return <output data-testid="focused">{focusedId ?? "none"}</output>
}

function press(options: KeyboardEventInit) {
	fireEvent.keyDown(document.body, options)
}

function focused(): string {
	return screen.getByTestId("focused").textContent ?? ""
}

afterEach(cleanup)

const IDS = ["a", "b", "c"]

describe("useListNavigation", () => {
	it("moves focus with j/k and arrow keys, clamped to bounds", () => {
		render(<Probe ids={IDS} />)
		expect(focused()).toBe("none")

		press({ key: "j" })
		expect(focused()).toBe("a")
		press({ key: "ArrowDown" })
		expect(focused()).toBe("b")
		press({ key: "j" })
		press({ key: "j" })
		expect(focused()).toBe("c")

		press({ key: "k" })
		expect(focused()).toBe("b")
		press({ key: "ArrowUp" })
		press({ key: "k" })
		expect(focused()).toBe("a")
	})

	it("opens the focused row on Enter", () => {
		const onOpen = vi.fn()
		render(<Probe ids={IDS} onOpen={onOpen} />)
		press({ key: "Enter" })
		expect(onOpen).not.toHaveBeenCalled()

		press({ key: "j" })
		press({ key: "Enter" })
		expect(onOpen).toHaveBeenCalledWith("a")
	})

	it("toggles selection with x, passing shiftKey through", () => {
		const onToggleSelect = vi.fn()
		render(<Probe ids={IDS} onToggleSelect={onToggleSelect} />)
		press({ key: "j" })
		press({ key: "x" })
		expect(onToggleSelect).toHaveBeenCalledWith("a", { shiftKey: false })
		press({ key: "X", shiftKey: true })
		expect(onToggleSelect).toHaveBeenCalledWith("a", { shiftKey: true })
	})

	it("Escape consults onEscape first, then clears focus", () => {
		const onEscape = vi.fn(() => true)
		render(<Probe ids={IDS} onEscape={onEscape} />)
		press({ key: "j" })
		press({ key: "Escape" })
		expect(onEscape).toHaveBeenCalledTimes(1)
		expect(focused()).toBe("a")

		onEscape.mockReturnValue(false)
		press({ key: "Escape" })
		expect(focused()).toBe("none")
	})

	it("reports the index to scrollTo", () => {
		const scrollTo = vi.fn()
		render(<Probe ids={IDS} scrollTo={scrollTo} />)
		press({ key: "j" })
		press({ key: "j" })
		expect(scrollTo).toHaveBeenLastCalledWith("b", 1)
	})

	it("is inert while a dialog is open and when disabled", () => {
		const { rerender } = render(<Probe ids={IDS} />)

		const dialog = document.createElement("div")
		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.appendChild(dialog)
		press({ key: "j" })
		expect(focused()).toBe("none")
		dialog.remove()

		rerender(<Probe ids={IDS} enabled={false} />)
		press({ key: "j" })
		expect(focused()).toBe("none")
	})
})
