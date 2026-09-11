// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useTypeAnywhereFocus } from "./use-type-anywhere-focus"

function Probe({ scoped }: { scoped: boolean }) {
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const regionRef = useRef<HTMLDivElement>(null)
	useTypeAnywhereFocus(textareaRef, true, scoped ? regionRef : undefined)
	return (
		<div ref={regionRef}>
			<textarea ref={textareaRef} data-testid="composer" />
		</div>
	)
}

/** A Base UI modal, which marks its open popup with a bare `data-open`. */
function openDialog(): HTMLDivElement {
	const dialog = document.createElement("div")
	dialog.setAttribute("role", "dialog")
	dialog.setAttribute("data-open", "")
	document.body.append(dialog)
	return dialog
}

afterEach(() => {
	cleanup()
	document.querySelectorAll("[role='dialog']").forEach((el) => el.remove())
})

describe("useTypeAnywhereFocus", () => {
	it("types into the composer from anywhere on the page when unscoped", () => {
		const { getByTestId } = render(<Probe scoped={false} />)
		fireEvent.keyDown(document.body, { key: "h" })
		const composer = getByTestId("composer") as HTMLTextAreaElement
		expect(composer.value).toBe("h")
		expect(document.activeElement).toBe(composer)
	})

	it("ignores keys outside its region when scoped", () => {
		const { getByTestId } = render(<Probe scoped />)
		fireEvent.keyDown(document.body, { key: "h" })
		expect((getByTestId("composer") as HTMLTextAreaElement).value).toBe("")
	})

	it("leaves the keyboard to an open dialog", () => {
		openDialog()
		const { getByTestId } = render(<Probe scoped={false} />)
		fireEvent.keyDown(document.body, { key: "h" })
		expect((getByTestId("composer") as HTMLTextAreaElement).value).toBe("")
	})

	it("stops the keystroke before the page's single-key shortcuts see it", () => {
		const onDocumentKey = vi.fn()
		document.addEventListener("keydown", onDocumentKey)
		render(<Probe scoped={false} />)
		fireEvent.keyDown(document.body, { key: "t" })
		expect(onDocumentKey).not.toHaveBeenCalled()
		document.removeEventListener("keydown", onDocumentKey)
	})

	it("leaves modifier combos and multi-char keys alone", () => {
		const { getByTestId } = render(<Probe scoped={false} />)
		fireEvent.keyDown(document.body, { key: "k", metaKey: true })
		fireEvent.keyDown(document.body, { key: "Escape" })
		expect((getByTestId("composer") as HTMLTextAreaElement).value).toBe("")
	})
})
