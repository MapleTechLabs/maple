import { Array as Arr } from "effect"
import { MAX_RAW_SQL_RESULT_BYTES, MAX_RAW_SQL_RESULT_ROWS } from "@maple/domain/raw-sql"
import type { QueryLimits, QueryWorkload } from "./port"

/** Same row and byte caps as raw SQL on Maple's warehouse; time and call budgets per workload. */
export const DEFAULT_LIMITS: Record<QueryWorkload, QueryLimits> = {
	interactive: {
		maxRows: MAX_RAW_SQL_RESULT_ROWS,
		maxBytes: MAX_RAW_SQL_RESULT_BYTES,
		timeoutMs: 30_000,
		maxCalls: 50,
		maxScanRows: 10_000,
	},
	dashboard: {
		maxRows: MAX_RAW_SQL_RESULT_ROWS,
		maxBytes: MAX_RAW_SQL_RESULT_BYTES,
		timeoutMs: 15_000,
		maxCalls: 40,
		maxScanRows: 10_000,
	},
	alert: {
		maxRows: MAX_RAW_SQL_RESULT_ROWS,
		maxBytes: MAX_RAW_SQL_RESULT_BYTES,
		timeoutMs: 30_000,
		maxCalls: 20,
		maxScanRows: 5_000,
	},
}

const NICE_BUCKETS_SECONDS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86_400, 7 * 86_400] as const
const TARGET_BUCKETS = 100

/** A bucket width giving at most ~100 points over the window, snapped to a readable size. */
export const defaultGranularitySeconds = (startMs: number, endMs: number): number => {
	const spanSeconds = Math.max(1, (endMs - startMs) / 1000)
	const wanted = spanSeconds / TARGET_BUCKETS
	return Arr.findFirst(NICE_BUCKETS_SECONDS, (bucket) => bucket >= wanted).pipe((found) =>
		found._tag === "Some" ? found.value : 30 * 86_400,
	)
}
