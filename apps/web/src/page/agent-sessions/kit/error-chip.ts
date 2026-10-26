import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"

/** Turn failures read red with the agent glyph; tool failures amber with the gear. */
export const TURN_CHIP = "border-severity-error/30 bg-severity-error/10 text-severity-error"
export const TOOL_CHIP = "border-severity-warn/40 bg-severity-warn/10 text-severity-warn"

/** `ErrorChip`: a failure count as a pill with its kind's glyph, the one error badge on agent views. */
export const errorChip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		iconName?: IconName
		count: number
		noun: string
		className: string
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
): Html =>
	h.span(
		[
			h.Class(cn(badgeVariants({ pill: true, size: "xs", mono: true }), options.className)),
			...(options.attributes ?? []),
		],
		[
			options.iconName === undefined
				? statusDot(h, { tone: "custom", size: "sm", className: "bg-current" })
				: icon(h, options.iconName, {
						size: 10,
						className: "shrink-0",
						attributes: [h.AriaHidden(true)],
					}),
			h.span(
				[],
				[
					h.span([h.Class("inline-block min-w-[2ch] text-right")], [String(options.count)]),
					" ",
					h.span(
						[h.Class("inline-block min-w-[5ch]")],
						[options.count === 1 ? options.noun : `${options.noun}s`],
					),
				],
			),
		],
	)
