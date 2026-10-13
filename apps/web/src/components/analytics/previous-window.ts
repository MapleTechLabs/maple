import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"

/**
 * The window immediately before this one, of the same length: the baseline the
 * deltas are measured against. "Last 7 days" compares against the 7 days before it.
 */
export function previousWindow(startTime: string, endTime: string) {
	const start = parseWarehouseDateTime(startTime)
	const end = parseWarehouseDateTime(endTime)
	const span = end - start
	return {
		startTime: formatWarehouseDateTime(start - span),
		endTime: startTime,
	}
}
