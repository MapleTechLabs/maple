// ---------------------------------------------------------------------------
// Warehouse DateTime normalization
//
// ClickHouse / Tinybird return `DateTime` columns as strings like
// "2026-05-24 14:30:00" — UTC, but with NO timezone marker and a space
// separator. Passing that shape to `new Date(str)` / `Date.parse(str)` makes
// V8 parse it as LOCAL time, shifting the value by the runtime's UTC offset.
//
// These helpers are the single source of truth for turning a warehouse
// DateTime string into an unambiguous UTC value. Already-zoned strings (with a
// `Z` or numeric offset) and non-matching shapes are passed through untouched.
// ---------------------------------------------------------------------------

const WAREHOUSE_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

/**
 * Normalize a warehouse (ClickHouse/Tinybird) DateTime string to an ISO-8601
 * UTC string with an explicit `Z`. Strings that don't match the tz-less
 * `YYYY-MM-DD HH:MM:SS[.fff]` shape (e.g. already carry a `Z`/offset, or aren't
 * timestamps) are returned trimmed but otherwise unchanged.
 */
export function warehouseDateTimeToIso(value: string): string {
	const trimmed = value.trim()
	const match = WAREHOUSE_DATETIME_PATTERN.exec(trimmed)
	if (!match) {
		return trimmed
	}

	const [, date, time, fractional] = match
	if (!fractional) {
		return `${date}T${time}Z`
	}

	const milliseconds = `${fractional}000`.slice(0, 3)
	return `${date}T${time}.${milliseconds}Z`
}

/**
 * Parse a warehouse DateTime string into epoch milliseconds, treating tz-less
 * values as UTC. Returns `NaN` for unparseable input (matching `Date.parse`).
 */
export function parseWarehouseDateTime(value: string): number {
	return Date.parse(warehouseDateTimeToIso(value))
}
