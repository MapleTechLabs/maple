import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { formatRelativeShortFrom, formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatSeen } from "../../metrics/time-format"

// `RelativeTime` (apps/web/src/components/common/relative-time.tsx). `nowMs` is the page's resolved
// clock (legacy reads `Date.now()` at render).
// TODO(tooltip): the styled tooltip variant renders its trigger only; the absolute-time popup on
// hover is not wired yet (the `title` variant carries it natively).

export type RelativeTimeOptions = Readonly<{
	value: string
	nowMs: number
	timeZone: string
	variant?: "long" | "short"
	prefix?: string
	mono?: boolean
	tooltip?: "tooltip" | "title"
	className?: string
}>

export const relativeTime = <M>(h: HtmlBuilder<M>, options: RelativeTimeOptions): Html => {
	const epochMs = toEpochMs(options.value)
	if (!Number.isFinite(epochMs))
		return h.span([h.Class(cn("text-muted-foreground", options.className))], [EMPTY_VALUE])
	const relative =
		options.variant === "short"
			? formatRelativeShortFrom(epochMs, options.nowMs)
			: formatRelativeTime(epochMs, options.nowMs)
	const label = options.prefix ? `${options.prefix} ${relative}` : relative
	const classes = cn(options.mono === true && "font-mono tabular-nums", options.className)
	const iso = new Date(epochMs).toISOString()
	if (options.tooltip === "title")
		return h.time(
			[
				h.Attribute("datetime", iso),
				h.Title(formatSeen(options.value, options.timeZone)),
				...(classes === "" ? [] : [h.Class(classes)]),
			],
			[label],
		)
	return h.time(
		[
			h.Class(cn("cursor-default", classes)),
			h.Attribute("datetime", iso),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[label],
	)
}
