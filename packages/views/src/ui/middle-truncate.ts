import { cn } from "@maple/ui/lib/utils"
import {
	middleTruncateHeadStyles,
	middleTruncateMonoStyles,
	middleTruncateStyles,
	middleTruncateTailStyles,
} from "@maple/ui/styles/ui/middle-truncate"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"

// Port of packages/ui/src/components/ui/middle-truncate.tsx: keeps the last `tail` characters
// visible and ellipsizes the middle. Pure CSS; the full value is always in `title`.

export interface MiddleTruncateOptions {
	readonly text: string
	readonly tail?: number
	readonly mono?: boolean
	readonly className?: string
}

export const middleTruncate = <M>(h: HtmlBuilder<M>, options: MiddleTruncateOptions): Html => {
	const tail = options.tail ?? 12
	const chars = Array.from(options.text)
	const attributes = [
		h.Class(
			cn(middleTruncateStyles, (options.mono ?? false) && middleTruncateMonoStyles, options.className),
		),
		h.Title(options.text),
	]
	// All tail up to one character past it: it never shrinks below what a long value keeps, and a
	// one-character head would leave a gap in the head's 2ch track.
	if (chars.length <= tail + 1) {
		return h.span(attributes, [h.span([h.Class(middleTruncateTailStyles)], [options.text])])
	}
	return h.span(attributes, [
		h.span([h.Class(middleTruncateHeadStyles)], [Arr.join(chars.slice(0, -tail), "")]),
		h.span([h.Class(middleTruncateTailStyles)], [Arr.join(chars.slice(-tail), "")]),
	])
}
