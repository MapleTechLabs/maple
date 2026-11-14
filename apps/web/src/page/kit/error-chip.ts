import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { errorCountPill } from "@maple/views/ui/error-count-pill"
import type { IconName } from "@maple/views/ui/icon"

/** Tool failures read amber: the chip class for a tool error that is not a count. */
export const TOOL_CHIP = "border-severity-warn-a4 bg-severity-warn-a2 text-severity-warn"

/** A failure count as an aligned pill: turn failures red with the agent glyph, tool failures amber
 * with the gear. */
export const errorChip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		iconName?: IconName
		count: number
		noun: string
		tone: "crit" | "warn"
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
): Html => errorCountPill(h, { ...options, isAligned: true })
