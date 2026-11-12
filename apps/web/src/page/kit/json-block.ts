import { cn } from "@maple/ui/lib/utils"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

/** A value as indented JSON text, for `jsonBlock`. */
export const prettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

/** A JSON document or other preformatted text in a scrolling well (an audit entry's payload). */
export const jsonBlock = <M>(h: HtmlBuilder<M>, text: string, className?: string): Html =>
	h.pre(
		[
			h.Class(
				cn(
					"bg-surface-well max-h-64 overflow-auto rounded-md border px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap wrap-anywhere",
					className,
				),
			),
		],
		[text],
	)
