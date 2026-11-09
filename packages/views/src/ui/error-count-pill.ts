import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { badge } from "./display"
import { icon, type IconName } from "./icon"
import { statusDot } from "./status-dot"

export type ErrorCountPillOptions<Message> = Readonly<{
	count: number
	/** The singular noun after the count ("error", the default); `null` draws the count alone. */
	noun?: string | null
	/** `warn` for failures that may have recovered (a tool call), `crit` otherwise. */
	tone?: "crit" | "warn"
	/** A glyph naming the failure's kind, in place of the dot. */
	iconName?: IconName
	/** Fixed-width count and noun, so a column of pills lines up. */
	isAligned?: boolean
	size?: "xs" | "default"
	className?: string
	attributes?: ReadonlyArray<Attribute<Message>>
}>

const EDGE = { crit: "border-severity-error-a3", warn: "border-severity-warn-a3" } as const

const alignedLabel = <Message>(h: HtmlBuilder<Message>, count: number, noun: string): Html =>
	h.span(
		[],
		[
			h.span([h.Class("inline-block min-w-[2ch] text-right")], [String(count)]),
			" ",
			h.span([h.Class("inline-block min-w-[5ch]")], [count === 1 ? noun : `${noun}s`]),
		],
	)

/** `ErrorCountPill`: a failure count as a toned pill, led by a dot or its kind's glyph. */
export const errorCountPill = <Message>(h: HtmlBuilder<Message>, options: ErrorCountPillOptions<Message>): Html => {
	const tone = options.tone ?? "crit"
	const noun = options.noun === undefined ? "error" : options.noun
	return badge(
		h,
		{
			pill: true,
			size: options.size ?? "xs",
			mono: true,
			variant: tone,
			className: cn("gap-1.5", EDGE[tone], options.className),
			attributes: options.attributes,
		},
		[
			options.iconName === undefined
				? statusDot(h, { tone, size: "sm" })
				: icon(h, options.iconName, {
						size: options.size === "default" ? 12 : 10,
						className: "shrink-0",
						attributes: [h.AriaHidden(true)],
					}),
			noun === null
				? String(options.count)
				: options.isAligned === true
					? alignedLabel(h, options.count, noun)
					: countLabel(options.count, noun),
		],
	)
}
