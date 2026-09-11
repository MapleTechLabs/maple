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

/**
 * Start typing anywhere and the text lands in the composer.
 *
 * `scope` bounds where "anywhere" means. A chat that owns the whole page listens on
 * the window, so a keystroke lands in the composer even with nothing focused; a chat
 * embedded in a page (the investigation workspace) passes its own region instead, or
 * it swallows every single-key global shortcut on that route — pressing `?` for the
 * shortcut sheet would silently type a question mark instead.
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
			if (isDialogOpen()) return

			const textarea = ref.current
			if (!textarea || textarea.disabled) return

			// Claim the keystroke before it reaches the app's single-key shortcuts: on a
			// full-page chat the composer is the only sane destination for a bare letter,
			// and without this, typing "t" would open the time picker AND type a "t".
			e.preventDefault()
			e.stopPropagation()
			textarea.focus()
			insertCharIntoTextarea(textarea, e.key)
		}

		// Capture phase, so the handler above runs before the document-level hotkey
		// manager and before React's own root listener.
		const target: HTMLElement | Window = scope?.current ?? window
		target.addEventListener("keydown", handler as EventListener, true)
		return () => target.removeEventListener("keydown", handler as EventListener, true)
	}, [ref, enabled, scope])
}
