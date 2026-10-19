import { cn } from "@maple/ui/lib/utils"
import {
	middleTruncateHeadStyles,
	middleTruncateMonoStyles,
	middleTruncateStyles,
	middleTruncateTailStyles,
} from "@maple/ui/styles/ui/middle-truncate"
import type { Html, HtmlBuilder } from "foldkit/html"

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
	if (chars.length <= tail * 2) {
		return h.span(attributes, [h.span([h.Class(middleTruncateHeadStyles)], [options.text])])
	}
	return h.span(attributes, [
		h.span([h.Class(middleTruncateHeadStyles)], [chars.slice(0, -tail).join("")]),
		h.span([h.Class(middleTruncateTailStyles)], [chars.slice(-tail).join("")]),
	])
}
