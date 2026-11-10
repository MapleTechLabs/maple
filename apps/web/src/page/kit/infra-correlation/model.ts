import { ChartEnvMessages, ChartEnvFields } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { TimeWindow } from "../../../data/time-range"
import { ChartModels, SeriesResult, SeriesSlots } from "../series"

// The infra correlation panel: the pod, node, container or host charts of the record a log sheet or
// span panel shows.

const Attributes = Schema.Record(Schema.String, Schema.String)

export const Model = Schema.Struct({
	id: Schema.String,
	/** The org the series are keyed under. */
	orgId: Schema.String,
	/** The window, resolved when the panel mounts (its fallback reads the clock). */
	window: Schema.NullOr(TimeWindow),
	/** One slot and chart per `<kind>-<metric>`. */
	series: SeriesSlots,
	charts: ChartModels,
	...ChartEnvFields,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	/** The panel is on screen: its window, for the record's resource attributes. */
	ResolvedWindow: { window: TimeWindow, resourceAttributes: Attributes },
	CompletedFetchSeries: { chartId: Schema.String, key: Schema.String, result: SeriesResult },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	...ChartEnvMessages,
	CompletedMountLinkedCursor: {},
})
export type Message = typeof Message.Type
