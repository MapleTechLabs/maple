import { String as Str, Array as Arr, Option } from "effect"
/**
 * Datasources that are written via `ingest` (hard-pinned to the managed
 * Tinybird pipeline) and have NO per-org materialization — they simply do not
 * exist in a BYO ClickHouse. Reads of these tables must route with purpose
 * "ingest" (declare `.route("ingest")` at the query definition).
 *
 * The executor uses this list as a safety net: a read that resolves to an
 * org-BYO backend while referencing one of these tables would silently return
 * empty rows, so it logs a warning instead of failing quietly.
 */
export const INGEST_PINNED_TABLES: ReadonlyArray<string> = ["alert_checks", "audit_log"]

export const findIngestPinnedTable = (sql: string): string | undefined =>
	Option.getOrUndefined(Arr.findFirst(INGEST_PINNED_TABLES, (table) => Str.includes(table)(sql)))
