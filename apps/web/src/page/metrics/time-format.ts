import { warehouseDateTimeToIso } from "@maple/query-engine"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { DateTime, Option } from "effect"

// Timestamps in the page's time zone, with the year: warehouse timestamps are tz-less UTC strings.

/** The instant a warehouse timestamp names, if it parses. */
export const epochMsOf = (value: string): Option.Option<number> =>
	Option.map(DateTime.make(warehouseDateTimeToIso(value)), DateTime.toEpochMillis)

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

/** "Sep 30, 2026, 12:05:00 PM" in the viewer's zone. */
export const formatSeen = (value: string, timeZone: string): string =>
	Option.match(epochMsOf(value), {
		onNone: () => EMPTY_VALUE,
		onSome: (epochMs) => formatterFor(timeZone).format(epochMs),
	})
