import type { Html, HtmlBuilder } from "foldkit/html"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { epochOf } from "./summary"

// `RelativeTime` (apps/web/src/components/common/relative-time.tsx), the `title` tooltip form.

const formatterFor = (timeZone: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})

/** `formatTimestampInTimezone(value, { timeZone, withYear: true })`. */
export const formatAbsolute = (epochMs: number, timeZone: string): string =>
	formatterFor(timeZone).format(epochMs)

/** `<RelativeTime variant="orDate" tooltip="title" mono>`: a `<time>` whose title is the absolute. */
export const relativeTimeOrDate = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ value: string; nowMs: number; timeZone: string; className?: string }>,
): Html => {
	const epochMs = epochOf(options.value)
	if (!Number.isFinite(epochMs))
		return h.span([h.Class(cn("text-muted-foreground", options.className))], [EMPTY_VALUE])
	return h.time(
		[
			h.Class(cn("font-mono tabular-nums", options.className)),
			h.Attribute("datetime", new Date(epochMs).toISOString()),
			h.Title(formatAbsolute(epochMs, options.timeZone)),
		],
		[formatRelativeTimeOrDate(epochMs, options.nowMs, options.timeZone)],
	)
}
