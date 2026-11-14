/**
 * Clipboard writes for every surface: the dashboard's commands and the non-Effect pages (the Astro
 * landing site, the crash page) share one implementation of the fiddly insecure-origin fallback.
 */

import { Effect, Option, Schema } from "effect"

import { trySync } from "./try-sync"

/**
 * Last-resort clipboard write for insecure origins and embedded contexts where
 * `navigator.clipboard` is missing or rejects. Restores the user's selection so
 * copying doesn't visibly steal the caret.
 */
export function writeClipboardFallback(text: string): boolean {
	if (typeof document === "undefined") return false

	const area = document.createElement("textarea")
	area.value = text
	area.setAttribute("readonly", "")
	area.style.position = "fixed"
	area.style.top = "0"
	area.style.left = "0"
	area.style.opacity = "0"
	document.body.appendChild(area)

	const selection = document.getSelection()
	const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

	area.select()
	// `execCommand` throws outright in a sandboxed frame rather than returning
	// false, so an unavailable command and a refused one are one answer.
	const ok = Option.getOrElse(
		// oxlint-disable-next-line typescript/no-deprecated -- fallback for contexts without the async Clipboard API.
		trySync(() => document.execCommand("copy")),
		() => false,
	)

	document.body.removeChild(area)
	if (selection && previous) {
		selection.removeAllRanges()
		selection.addRange(previous)
	}
	return ok
}

class ClipboardWriteError extends Schema.TaggedError<ClipboardWriteError>()(
	"@maple/web/ClipboardWriteError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Write `text` through `navigator.clipboard`, falling back to the hidden textarea when the API is
 * missing or rejects (an insecure origin, a denied permission, an unfocused document). Whether it landed.
 */
export const writeClipboard = (text: string): Effect.Effect<boolean> =>
	Effect.tryPromise({
		try: () => navigator.clipboard.writeText(text),
		catch: (cause) => new ClipboardWriteError({ message: "The clipboard API refused the write", cause }),
	}).pipe(
		Effect.as(true),
		Effect.catch(() =>
			Effect.try({
				try: () => writeClipboardFallback(text),
				catch: (cause) =>
					new ClipboardWriteError({ message: "The fallback clipboard write failed", cause }),
			}),
		),
		Effect.orElseSucceed(() => false),
	)

/** `writeClipboard` as a promise for the non-Effect surfaces; an empty value is refused. */
export async function writeClipboardText(text: string): Promise<boolean> {
	if (!text) return false
	return Effect.runPromise(writeClipboard(text))
}
