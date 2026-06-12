import { getTableColumns } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

// ---------------------------------------------------------------------------
// Cloudflare D1 bound-parameter limits.
//
// D1 caps bound parameters at 100 per SQL statement, and the limit applies to
// each statement (including each statement inside a `db.batch([...])`):
//   https://developers.cloudflare.com/d1/platform/limits/
//
// A multi-row `INSERT ... VALUES (...), (...)` binds (rows × columns)
// parameters, so bulk inserts must be chunked. Derive the chunk size from the
// table's LIVE column count rather than a hand-counted magic number — that way
// adding a column can never silently push a chunk past the cap.
// ---------------------------------------------------------------------------
const D1_MAX_BOUND_PARAMS = 100

/**
 * Maximum number of rows that fit in a single multi-row INSERT into `table`
 * without exceeding D1's bound-parameter cap. Conservative: uses the table's
 * full column count (a superset of the columns any given row binds).
 */
export const maxRowsPerInsert = (table: SQLiteTable): number =>
	Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / Object.keys(getTableColumns(table)).length))

/**
 * Split `rows` into chunks small enough that each multi-row INSERT into `table`
 * stays within D1's bound-parameter cap. Use with `Effect.forEach(..., { discard: true })`.
 */
export const chunkRowsForInsert = <T>(table: SQLiteTable, rows: ReadonlyArray<T>): Array<Array<T>> => {
	const size = maxRowsPerInsert(table)
	const chunks: Array<Array<T>> = []
	for (let i = 0; i < rows.length; i += size) {
		chunks.push(rows.slice(i, i + size))
	}
	return chunks
}
