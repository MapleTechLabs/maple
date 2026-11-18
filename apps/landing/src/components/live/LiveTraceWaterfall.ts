import type { TraceData } from "@maple/views/traces/trace-data"
import * as Waterfall from "@maple/views/traces/waterfall"
import { flatTreeOf } from "@maple/views/traces/waterfall/tree"
import { ROW_HEIGHT } from "@maple/views/traces/waterfall/virtualize"
import { Array as Arr, Schema } from "effect"
import { makeIsland } from "../../foldkit-island/island"
import {
	BASE_TIME,
	CHECKOUT_TRACE_ID,
	ROOT_SPANS,
	TOTAL_DURATION_MS,
	WATERFALL_ROWS,
} from "../trace-explorer/fixture"

const checkoutTrace: TraceData = {
	traceId: CHECKOUT_TRACE_ID,
	spans: Arr.map(WATERFALL_ROWS, ({ span }) => span),
	rootSpans: ROOT_SPANS,
	totalDurationMs: TOTAL_DURATION_MS,
	traceStartTime: BASE_TIME,
}

export const LiveTraceWaterfall = makeIsland({
	name: "LiveTraceWaterfall",
	Props: Schema.Struct({}),
	Model: Waterfall.Model,
	init: () => {
		const { model, commands } = Waterfall.init({
			trace: checkoutTrace,
			traceStartTime: BASE_TIME,
			selectedSpanId: null,
		})
		const { rows } = flatTreeOf(model.rootSpans, model.expanded)
		// The browser measures the rows when it mounts. The static build can show this small trace in full.
		return {
			model: {
				...model,
				virtualRows: Arr.map(rows, (_, index) => ({ index, start: index * ROW_HEIGHT })),
				totalSize: rows.length * ROW_HEIGHT,
			},
			commands,
		}
	},
	update: (model, message: Waterfall.Message) => {
		const next = Waterfall.update(model, message)
		if (next.outMessage === undefined) return { model: next.model, commands: next.commands }
		const selected = Waterfall.setSelectedSpanId(next.model, next.outMessage.spanId)
		return { model: selected.model, commands: [...(next.commands ?? []), ...(selected.commands ?? [])] }
	},
	view: (model, h) => Waterfall.view(model, {}, h),
})
