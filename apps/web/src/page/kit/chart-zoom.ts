import { formatWarehouseDateTime } from "@maple/query-engine"
import type { ChartRange } from "@maple/views/charts/linked-cursor"
import type { TimeSearchPatch } from "./time-range-picker"

const MIN_ZOOM_MS = 60_000

/** A span dragged across a chart as the URL's absolute window: whole seconds, at least a minute, no preset. */
export const zoomSearchPatch = (range: ChartRange): TimeSearchPatch => {
	const startMs = Math.floor(range.startMs / 1000) * 1000
	const endMs = Math.max(Math.ceil(range.endMs / 1000) * 1000, startMs + MIN_ZOOM_MS)
	return {
		startTime: formatWarehouseDateTime(startMs),
		endTime: formatWarehouseDateTime(endMs),
		timePreset: undefined,
	}
}
