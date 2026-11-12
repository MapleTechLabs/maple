import { formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"

// Reads over tables that hold one row per whole day: a window is floored to the midnight-UTC
// `Date` rows it covers, both ends inclusive.

const DAY_MS = 86_400_000

const floorDay = (value: string): number => Math.floor(parseWarehouseDateTime(value) / DAY_MS) * DAY_MS

/**
 * The days a window covers, capped at `completeThrough` so a partial day never counts, and the
 * equal-length run of days before them. A window wholly past the cap covers no day.
 */
export const wholeDayWindow = (window: {
	readonly startTime: string
	readonly endTime: string
	readonly completeThrough?: string
}) => {
	const start = floorDay(window.startTime)
	const requestedEnd = Math.max(start, floorDay(window.endTime))
	const end =
		window.completeThrough === undefined
			? requestedEnd
			: Math.min(requestedEnd, parseWarehouseDateTime(`${window.completeThrough} 00:00:00`))
	const days = Math.max(0, Math.round((end - start) / DAY_MS) + 1)
	return {
		startDate: formatWarehouseDateTime(start),
		endDate: formatWarehouseDateTime(end),
		/** The last second of the end day, for reads over timestamps rather than days. */
		endOfDay: formatWarehouseDateTime(end + DAY_MS - 1000),
		previousStartDate: formatWarehouseDateTime(start - days * DAY_MS),
		/** How many days the window covers. */
		days,
	}
}
