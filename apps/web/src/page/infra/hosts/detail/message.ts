import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraHostSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import { SeriesResult } from "../../kit/series"
import { HostSummary } from "./model"

export const HostMetric = Schema.Literals(["cpu", "memory", "filesystem", "network", "load15"])
export type HostMetric = typeof HostMetric.Type

export const Message = defineMessageUnion({
	CompletedFetchSummary: { key: Schema.String, result: Schema.Result(HostSummary, LoadFailure) },
	CompletedFetchSeries: { metric: HostMetric, key: Schema.String, result: SeriesResult },
	ClickedRetrySummary: {},
	ClickedWidenRange: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedMountLinkedCursor: {},
	/** The frame resolved a window, relayed back so the update can read the org it keys by. */
	ResolvedFrameWindow: { mode: Frame.RequestMode },
	/** Same instance, new search (the root's `routeChanged`). */
	InformedOfRouteChange: { search: InfraHostSearch },
	/** The namespace pin or time zone changed (the root's `contextChanged`). */
	InformedOfContextChange: {},
})
export type Message = typeof Message.Type
