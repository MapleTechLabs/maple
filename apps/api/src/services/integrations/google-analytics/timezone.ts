/**
 * GA4 `dateHour` → UTC epoch milliseconds.
 *
 * The Data API expresses `dateHour` ("YYYYMMDDHH") in the PROPERTY'S configured reporting
 * timezone, not UTC, and says so nowhere in the response. A property set to
 * `America/Los_Angeles` reporting hour `2026090914` means 14:00 Pacific — 21:00 or 22:00 UTC
 * depending on the date. Treating the string as UTC would shift every bucket by a whole number
 * of hours, consistently and invisibly: the chart would look plausible and be wrong, and the
 * reconciliation ledger would happily keep it consistent with itself.
 *
 * The conversion is done against the platform's own tz database via `Intl` rather than a date
 * library, so it tracks DST rule changes without a dependency to keep current.
 */

/** Cached per zone — constructing an `Intl.DateTimeFormat` is expensive and this runs per row. */
const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (timeZone: string): Intl.DateTimeFormat | null => {
	const cached = formatters.get(timeZone)
	if (cached !== undefined) return cached
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			// h23, not hour12:false — the latter renders midnight as "24" on some engines, which
			// would push every midnight bucket a day forward.
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
		formatters.set(timeZone, formatter)
		return formatter
	} catch {
		// An unknown IANA zone (a GA4 property configured with something this runtime's tz
		// database has never heard of). Reported as null so the caller skips the property rather
		// than silently filing its data under the wrong hour.
		return null
	}
}

/** Offset in ms of `timeZone` at a given UTC instant: (wall-clock time there) − (UTC time). */
const offsetAt = (formatter: Intl.DateTimeFormat, utcMs: number): number => {
	const parts = formatter.formatToParts(new Date(utcMs))
	const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
		const part = parts.find((candidate) => candidate.type === type)
		return part === undefined ? 0 : Number(part.value)
	}
	const asIfUtc = Date.UTC(
		lookup("year"),
		lookup("month") - 1,
		lookup("day"),
		lookup("hour"),
		lookup("minute"),
		lookup("second"),
	)
	return asIfUtc - utcMs
}

/**
 * Convert a GA4 `dateHour` in `timeZone` to the UTC epoch ms of that hour's start.
 *
 * Returns null for a malformed `dateHour` or an unknown timezone — both mean "we cannot place
 * this row on the timeline", and a skipped row is strictly better than a misplaced one.
 */
export const dateHourToUtcMs = (dateHour: string, timeZone: string): number | null => {
	if (!/^\d{10}$/.test(dateHour)) return null
	const year = Number(dateHour.slice(0, 4))
	const month = Number(dateHour.slice(4, 6))
	const day = Number(dateHour.slice(6, 8))
	const hour = Number(dateHour.slice(8, 10))
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null

	const formatter = formatterFor(timeZone)
	if (formatter === null) return null

	// Solve `localWallClock(utc) == target` by fixed point. The first guess uses the offset at the
	// naive instant; one refinement settles it, because a second application lands on the correct
	// side of any DST transition (offsets change by at most a couple of hours, far less than the
	// day-wide window the first guess is already inside).
	const target = Date.UTC(year, month - 1, day, hour)
	const firstGuess = target - offsetAt(formatter, target)
	const refined = target - offsetAt(formatter, firstGuess)
	return refined
}

/** UTC epoch ms → the `YYYY-MM-DD` the Data API wants for a date range, in `timeZone`. */
export const utcMsToZonedDate = (utcMs: number, timeZone: string): string | null => {
	const formatter = formatterFor(timeZone)
	if (formatter === null) return null
	const parts = formatter.formatToParts(new Date(utcMs))
	const value = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((candidate) => candidate.type === type)?.value ?? ""
	const year = value("year")
	const month = value("month")
	const day = value("day")
	if (year === "" || month === "" || day === "") return null
	return `${year}-${month}-${day}`
}
