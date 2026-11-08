// Google Search Console's calendar: Google reports days in Pacific time, as YYYY-MM-DD.
import { DateTime } from "effect"

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
