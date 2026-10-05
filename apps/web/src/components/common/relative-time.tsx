import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import {
	formatRelativeShort,
	formatRelativeTime,
	formatRelativeTimeOrDate,
	type TimeInput,
	toEpochMs,
} from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

/**
 * "5m ago" with the absolute time, in the viewer's selected timezone, on hover.
 * Use this instead of pairing a relative label with `toLocaleString()` (which
 * ignores the timezone setting) or a raw ISO tooltip.
 */
export function RelativeTime({
	value,
	variant = "long",
	prefix,
	mono = false,
	tooltip = "tooltip",
	className,
}: {
	value: TimeInput
	/** `long` "5 minutes ago", `short` "5m", `orDate` relative inside a week, a date beyond. */
	variant?: "long" | "short" | "orDate"
	/** Leading words inside the same span ("Last seen"). */
	prefix?: string
	mono?: boolean
	/** `tooltip` is the styled popover; `title` the native attribute for dense tables. */
	tooltip?: "tooltip" | "title"
	className?: string
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const epochMs = toEpochMs(value)
	if (!Number.isFinite(epochMs)) {
		return <span className={cn("text-muted-foreground", className)}>—</span>
	}

	const relative =
		variant === "short"
			? formatRelativeShort(epochMs)
			: variant === "orDate"
				? formatRelativeTimeOrDate(epochMs, Date.now(), effectiveTimezone)
				: formatRelativeTime(epochMs)
	const absolute = formatTimestampInTimezone(epochMs, { timeZone: effectiveTimezone, withYear: true })
	const label = prefix ? `${prefix} ${relative}` : relative
	const classes = cn(mono && "font-mono tabular-nums", className)
	const iso = new Date(epochMs).toISOString()

	if (tooltip === "title") {
		return (
			<time dateTime={iso} title={absolute} className={classes}>
				{label}
			</time>
		)
	}

	return (
		<Tooltip>
			<TooltipTrigger render={<time dateTime={iso} />} className={cn("cursor-default", classes)}>
				{label}
			</TooltipTrigger>
			<TooltipContent>{absolute}</TooltipContent>
		</Tooltip>
	)
}
