// Google Search Console's calendar: Google reports days in Pacific time, as YYYY-MM-DD.
import { DateTime, String as Str } from "effect"

const pacificDay = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
})

/** The YYYY-MM-DD it is in Pacific time at `epochMs`: Google's "today". */
export const pacificToday = (epochMs: number): string => pacificDay.format(new Date(epochMs))

/** `day` moved by `days` (negative for earlier). */
export const addDays = (day: string, days: number): string =>
	DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days }))

/**
 * The last complete day of a property's data. The importer reads through today, so the watermark
 * can be today's partial day; the last whole day is the watermark or yesterday, whichever is earlier.
 */
export const completeThrough = (watermarkDate: string, todayPacific: string): string => {
	const yesterday = addDays(todayPacific, -1)
	return watermarkDate < yesterday ? watermarkDate : yesterday
}

/** Google keeps 16 months of Search Analytics data. */
export const HISTORY_MONTHS = 16

const DAY_MS = 86_400_000

const dayStart = (day: string) => DateTime.makeUnsafe(`${day}T00:00:00Z`)

/** The oldest day Google still answers for, `HISTORY_MONTHS` before `today`. */
export const historyFloor = (today: string): string =>
	DateTime.formatIsoDateUtc(DateTime.subtract(dayStart(today), { months: HISTORY_MONTHS }))

/**
 * The Google days a window covers (its UTC `YYYY-MM-DD HH:mm:ss` bounds floored to days, the end
 * capped at `completeThrough`) and the first day of the equal-length period before it.
 */
export const searchConsoleWindowDays = (window: {
	readonly startTime: string
	readonly endTime: string
	readonly completeThrough?: string
}) => {
	const startDay = Str.slice(0, 10)(window.startTime)
	const requestedEnd = Str.slice(0, 10)(window.endTime)
	const uncapped = requestedEnd < startDay ? startDay : requestedEnd
	const endDay =
		window.completeThrough !== undefined && window.completeThrough < uncapped
			? window.completeThrough
			: uncapped
	const days = Math.max(
		0,
		Math.round(
			(DateTime.toEpochMillis(dayStart(endDay)) - DateTime.toEpochMillis(dayStart(startDay))) / DAY_MS,
		) + 1,
	)
	return { startDay, endDay, previousStartDay: addDays(startDay, -days) }
}

/**
 * Whether a property's history is imported from `day` on. Backfill walks down from the first
 * import, so days before `backfillDate` are still coming, unless backfill reached Google's floor.
 */
export const isImportedFrom = (day: string, backfillDate: string | null, todayPacific: string): boolean =>
	backfillDate !== null && (day >= backfillDate || backfillDate <= historyFloor(todayPacific))

/** Which periods of a window are fully imported: deltas need both. */
export const searchConsoleCoverage = (
	window: { readonly startTime: string; readonly endTime: string; readonly completeThrough?: string },
	backfillDate: string | null,
	todayPacific: string,
) => {
	const days = searchConsoleWindowDays(window)
	return {
		...days,
		current: isImportedFrom(days.startDay, backfillDate, todayPacific),
		previous: isImportedFrom(days.previousStartDay, backfillDate, todayPacific),
	}
}
