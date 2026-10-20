import { Clock, Effect, Option, Schema } from "effect"
import { browserZone, readSupportedTimeZones, SYSTEM_VALUE } from "../../platform/time-zone"

// The zone list logic of the timezone select.

/** One option: `__system__` or an IANA zone, with what it shows frozen at the list's open. */
export const ZoneRow = Schema.Struct({
	value: Schema.String,
	zone: Schema.String,
	region: Schema.String,
	city: Schema.String,
	clock: Schema.String,
	offset: Schema.String,
	isPinned: Schema.Boolean,
	/** The first zone after System and UTC: its group draws the separator. */
	startsGroup: Schema.Boolean,
})
export type ZoneRow = typeof ZoneRow.Type

/** An unknown zone throws in the constructor; it then shows `UTC` / `--:--`. */
const offsetFormatter = Option.liftThrowable(
	(timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }),
)
const clockFormatter = Option.liftThrowable(
	(timeZone: string) =>
		new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }),
)

/** `formatUtcOffset`: `UTC+2`, `UTC-5:30`, `UTC`, the offset a zone is on at `atMs`. */
export const formatUtcOffset = (timeZone: string, atMs: number): string => {
	const part = Option.match(offsetFormatter(timeZone), {
		onNone: () => "GMT",
		onSome: (formatter) => formatter.formatToParts(atMs).find((entry) => entry.type === "timeZoneName")?.value ?? "GMT",
	})
	const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part)
	if (match === null) return "UTC"
	const [, sign, hours, minutes] = match
	return `UTC${sign}${Number(hours)}${minutes !== undefined && minutes !== "00" ? `:${minutes}` : ""}`
}

/** Minutes east of UTC, read back off the formatted offset (the sort key of the groups). */
const offsetMinutes = (offset: string): number => {
	const match = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offset)
	if (match === null) return 0
	const [, sign, hours, minutes] = match
	return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0))
}

/** `formatClock`: `16:52`, what the clock reads in the zone at `atMs`. */
const formatClock = (timeZone: string, atMs: number): string =>
	Option.match(clockFormatter(timeZone), { onNone: () => "--:--", onSome: (formatter) => formatter.format(atMs) })

/** `Europe/Berlin` → `Europe` + `Berlin`; `America/Argentina/San_Juan` → `America` + `Argentina / San Juan`. */
const splitZone = (zone: string): { readonly region: string; readonly city: string } => {
	const slash = zone.indexOf("/")
	if (slash === -1) return { region: "Other", city: zone }
	return { region: zone.slice(0, slash), city: zone.slice(slash + 1).replaceAll("_", " ").replaceAll("/", " / ") }
}

/** `itemLabel`: the option's text label. */
export const zoneLabel = (row: ZoneRow): string => (row.value === SYSTEM_VALUE ? `System (${row.zone})` : row.value)

/** `matchesQuery`: the zone id, its offset, or the time it is there right now. */
export const matchesZoneQuery = (row: ZoneRow, query: string): boolean => {
	const needle = query.trim().toLowerCase().replaceAll("_", " ")
	if (needle.length === 0) return true
	return `${zoneLabel(row)} ${row.offset} ${row.clock}`.toLowerCase().replaceAll("_", " ").includes(needle)
}

const rowOf = (value: string, zone: string, atMs: number, isPinned: boolean, startsGroup: boolean): ZoneRow => ({
	value,
	zone,
	...splitZone(zone),
	clock: formatClock(zone, atMs),
	offset: formatUtcOffset(zone, atMs),
	isPinned,
	startsGroup,
})

/** `groupZones`: System and UTC pinned, then every other zone west to east, A-Z within an offset. */
export const zoneRows = (zones: ReadonlyArray<string>, browser: string, atMs: number): ReadonlyArray<ZoneRow> => {
	const sorted = zones
		.filter((zone) => zone !== "UTC")
		.map((zone) => rowOf(zone, zone, atMs, false, false))
		.sort((a, b) => offsetMinutes(a.offset) - offsetMinutes(b.offset) || a.zone.localeCompare(b.zone))
		.map((row, index) => (index === 0 ? { ...row, startsGroup: true } : row))
	return [rowOf(SYSTEM_VALUE, browser, atMs, true, false), rowOf("UTC", "UTC", atMs, true, false), ...sorted]
}

/** The list as it opens: `now` frozen per open. */
export const readZoneRows: Effect.Effect<ReadonlyArray<ZoneRow>> = Effect.map(
	Effect.all([readSupportedTimeZones, browserZone, Clock.currentTimeMillis]),
	([zones, browser, nowMs]) => zoneRows(zones, browser, nowMs),
)
