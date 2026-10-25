import { Schema } from "effect"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraKubernetesServiceSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import { ChartModels, SeriesRow } from "../../kit/series"
import * as Rail from "../lens/rail"
import { PodsPage } from "../pod-data"

// `/infra/kubernetes/services/$serviceName`: the service lens, latency and CPU-of-limit on one axis.

/** The fields of a `getServiceDetailOverview` point the lens reads. */
export const ServicePoint = Schema.Struct({
	bucket: Schema.String,
	p99LatencyMs: Schema.Number,
	throughput: Schema.Number,
	totalCount: Schema.Number,
})
export type ServicePoint = typeof ServicePoint.Type

export const Model = Schema.Struct({
	/** `null` on `/infra/kubernetes/services`: the lens with nothing picked (same instance, so the rail survives a pick). */
	serviceName: Schema.NullOr(Schema.String),
	search: InfraKubernetesServiceSearch,
	frame: Frame.Model,
	rail: Rail.Model,
	/** `serviceWorkloads` for this one service: its dominant workload. */
	linked: KeyedSchema(Rail.ServiceWorkloads, LoadFailure),
	overview: KeyedSchema(Schema.Array(ServicePoint), LoadFailure),
	/** The worst-per-bucket source: CPU of limit per pod. */
	cpu: KeyedSchema(Schema.Array(SeriesRow), LoadFailure),
	pods: KeyedSchema(PodsPage, LoadFailure),
	charts: ChartModels,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
