import { Schema } from "effect"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { ChartModels, SeriesSlots } from "../../kit/series"
import { PodMetric, PodSummary } from "../pod-data"

// `PodPeekSheet`: a pod's page in a sheet over the list.

/** Limits first (what the list is sorted by), then the raw cores and the requests. */
export const PEEK_METRICS: ReadonlyArray<PodMetric> = [
	"cpu_limit",
	"memory_limit",
	"cpu_usage",
	"cpu_request",
	"memory_request",
]

/** Shorter than the pod page's plot: five of them stack in a 576px sheet. */
export const PEEK_CHART_HEIGHT = 150

export const SummarySlot = KeyedSchema(PodSummary, LoadFailure)
export type SummarySlot = typeof SummarySlot.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** By `podKey`: the peeked pod and its neighbours, warmed so a step lands on data. */
	summaries: Schema.Record(Schema.String, SummarySlot),
	/** By `seriesId(podKey, metric)`. */
	series: SeriesSlots,
	/** By metric: the charts are not keyed by pod, so a step redraws in place. */
	charts: ChartModels,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type

export const seriesId = (podKey: string, metric: PodMetric) => `${podKey}\u0000${metric}`
