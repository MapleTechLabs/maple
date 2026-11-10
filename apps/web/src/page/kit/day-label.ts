import { Array as Arr, Option } from "effect"

// Calendar days in a time zone, for lists grouped by day ("Today", "Yesterday", "Mon 2 Nov").

/** The page's resolved clock: now, and the zone days are counted in. */
export type DayClock = Readonly<{ nowMs: number; timeZone: string }>

const timeFormat = (timeZone: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-GB", { timeZone, ...options })

/** The local calendar day of `atMs` as a sortable key: two instants share it when they share a day. */
export const dayKey = (atMs: number, timeZone: string): string =>
	timeFormat(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(atMs)

/** The local calendar day as a day count, so "yesterday" is one less even across a DST change. */
const dayNumber = (atMs: number, timeZone: string): number => {
	const parts = timeFormat(timeZone, { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(
		atMs,
	)
	const part = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(
			Option.getOrElse(
				Option.map(
					Arr.findFirst(parts, (entry) => entry.type === type),
					(entry) => entry.value,
				),
				() => "0",
			),
		)
	return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000
}

/** "Today", "Yesterday", else "Mon 2 Nov". */
export const dayLabel = (atMs: number, clock: DayClock): string => {
	const day = dayNumber(atMs, clock.timeZone)
	const today = dayNumber(clock.nowMs, clock.timeZone)
	if (day === today) return "Today"
	if (day === today - 1) return "Yesterday"
	return timeFormat(clock.timeZone, { weekday: "short", day: "numeric", month: "short" }).format(atMs)
}
