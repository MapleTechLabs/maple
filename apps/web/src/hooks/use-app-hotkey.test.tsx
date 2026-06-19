// @vitest-environment jsdom

import { detectPlatform } from "@tanstack/react-hotkeys"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ShortcutId } from "@/lib/shortcuts"

import { useAppHotkey } from "./use-app-hotkey"

function Probe(props: { id: ShortcutId; onTrigger: () => void; enabled?: boolean }) {
	useAppHotkey(
		props.id,
		props.onTrigger,
		props.enabled === undefined ? undefined : { enabled: props.enabled },
	)
	return null
}

function pressKey(options: KeyboardEventInit) {
	fireEvent.keyDown(document.body, options)
}

/** Modifier flag matching how `Mod` resolves on the current (jsdom) platform. */
function modFlag(): { metaKey: boolean } | { ctrlKey: boolean } {
	return detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true }
}

afterEach(() => {
	cleanup()
	document.querySelectorAll("[role='dialog']").forEach((el) => el.remove())
})

describe("useAppHotkey", () => {
	it("fires the handler for the registry combo", () => {
		const onTrigger = vi.fn()
		render(<Probe id="time.open" onTrigger={onTrigger} />)
		pressKey({ key: "d" })
		expect(onTrigger).toHaveBeenCalledTimes(1)
	})

	it("fires for aliases too", () => {
		const onTrigger = vi.fn()
		render(<Probe id="list.next" onTrigger={onTrigger} />)
		pressKey({ key: "j" })
		pressKey({ key: "ArrowDown" })
		expect(onTrigger).toHaveBeenCalledTimes(2)
	})

	it("requires the registered modifiers", () => {
		const onTrigger = vi.fn()
		render(<Probe id="chat.newTab" onTrigger={onTrigger} />)
		pressKey({ key: "o" })
		expect(onTrigger).not.toHaveBeenCalled()
		pressKey({ key: "o", shiftKey: true, ...modFlag() })
		expect(onTrigger).toHaveBeenCalledTimes(1)
	})

	it("ignores single-key shortcuts while typing in an input", () => {
		const onTrigger = vi.fn()
		const { container } = render(
			<>
				<Probe id="time.open" onTrigger={onTrigger} />
				<input type="text" />
			</>,
		)
		const input = container.querySelector("input")
		expect(input).not.toBeNull()
		if (input) fireEvent.keyDown(input, { key: "d" })
		expect(onTrigger).not.toHaveBeenCalled()
	})

	it("is suppressed while a Base UI dialog is open", () => {
		const onTrigger = vi.fn()
		render(<Probe id="time.open" onTrigger={onTrigger} />)

		const dialog = document.createElement("div")
		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.appendChild(dialog)

		pressKey({ key: "d" })
		expect(onTrigger).not.toHaveBeenCalled()

		dialog.remove()
		pressKey({ key: "d" })
		expect(onTrigger).toHaveBeenCalledTimes(1)
	})

	it("still fires shortcuts marked allowWhenDialogOpen while a dialog is open", () => {
		const onTrigger = vi.fn()
		render(<Probe id="palette.open" onTrigger={onTrigger} />)

		const dialog = document.createElement("div")
		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.appendChild(dialog)

		pressKey({ key: "k", ...modFlag() })
		expect(onTrigger).toHaveBeenCalledTimes(1)
	})

	it("respects enabled: false without unregistering", () => {
		const onTrigger = vi.fn()
		const { rerender } = render(<Probe id="time.open" onTrigger={onTrigger} enabled={false} />)
		pressKey({ key: "d" })
		expect(onTrigger).not.toHaveBeenCalled()

		rerender(<Probe id="time.open" onTrigger={onTrigger} enabled={true} />)
		pressKey({ key: "d" })
		expect(onTrigger).toHaveBeenCalledTimes(1)
	})
})
