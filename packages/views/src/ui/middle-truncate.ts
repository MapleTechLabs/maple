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
	// Up to one character past the tail the value stays whole: a plain span, not the grid, so its
	// min-content is the whole text and no shrink weight can squeeze it under its neighbours.
	if (chars.length <= tail + 1) {
		return h.span(
			[
				h.Class(
					cn(
						"whitespace-pre",
						(options.mono ?? false) && middleTruncateMonoStyles,
						options.className,
					),
				),
				h.Title(options.text),
			],
			[options.text],
		)
	}
	return h.span(attributes, [
		h.span([h.Class(middleTruncateHeadStyles)], [Arr.join(chars.slice(0, -tail), "")]),
		h.span([h.Class(middleTruncateTailStyles)], [Arr.join(chars.slice(-tail), "")]),
	])
}
