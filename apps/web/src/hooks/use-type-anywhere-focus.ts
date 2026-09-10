import { useEffect, type RefObject } from "react"
import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"

function insertCharIntoTextarea(textarea: HTMLTextAreaElement, char: string): void {
	const start = textarea.selectionStart ?? textarea.value.length
	const end = textarea.selectionEnd ?? textarea.value.length
	const nextValue = textarea.value.slice(0, start) + char + textarea.value.slice(end)

	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
	setter?.call(textarea, nextValue)

	const caret = start + char.length
	textarea.setSelectionRange(caret, caret)
	textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

/** True when the composer itself lives inside the open dialog, so the dialog is the chat. */
function isInsideOpenDialog(node: HTMLElement): boolean {
	return node.closest('[role="dialog"][data-open], [role="alertdialog"][data-open]') !== null
}

/**
 * Start typing anywhere and the text lands in the composer.
 *
 * `scope` bounds where "anywhere" means. A chat that owns the whole viewport (or an
 * open chat panel, which traps focus) listens on the window, so a keystroke with
 * nothing focused still reaches the composer; a chat embedded in a page (the
 * investigation workspace) passes its own region instead, or it swallows every
 * single-key global shortcut on that route — pressing `?` for the shortcut sheet
 * would silently type a question mark instead.
 */
export function useTypeAnywhereFocus(
	ref: RefObject<HTMLTextAreaElement | null>,
	enabled: boolean,
	scope?: RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		if (!enabled) return

		const handler = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (e.key.length !== 1) return
			if (isEditableTarget(e.target)) return
			const textarea = ref.current
			if (!textarea || textarea.disabled) return
			// A modal owns the keyboard — unless this composer is the thing inside it,
			// which is exactly the case for the global chat panel.
			if (isDialogOpen() && !isInsideOpenDialog(textarea)) return

			e.preventDefault()
			textarea.focus()
			insertCharIntoTextarea(textarea, e.key)
		}

		const target: HTMLElement | Window = scope?.current ?? window
		target.addEventListener("keydown", handler as EventListener)
		return () => target.removeEventListener("keydown", handler as EventListener)
	}, [ref, enabled, scope])
}
