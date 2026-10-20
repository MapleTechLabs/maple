import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraCloudflareWorkerSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { PlatformResources, Release, Status, Usage, WorkerDetail, WorkerRow } from "../data"

// `/infra/cloudflare/workers/$scriptName`.

export const Model = Schema.Struct({
	scriptName: Schema.String,
	search: InfraCloudflareWorkerSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(Status, LoadFailure),
	usage: KeyedSchema(Usage, LoadFailure),
	detail: KeyedSchema(WorkerDetail, LoadFailure),
	/** The list rollups carry the window's p99s and DO totals. */
	workers: KeyedSchema(Schema.Array(WorkerRow), LoadFailure),
	platform: KeyedSchema(PlatformResources, LoadFailure),
	releases: KeyedSchema(Schema.Array(Release), LoadFailure),
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: result(Status),
	CompletedLoadUsage: result(Usage),
	CompletedFetchDetail: result(WorkerDetail),
	CompletedFetchWorkers: result(Schema.Array(WorkerRow)),
	CompletedFetchPlatform: result(PlatformResources),
	CompletedFetchReleases: result(Schema.Array(Release)),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	AttachedLinkedCursor: {},
	/** The poll reads the clock so the phase can advance to "stalled". */
	TickedIngestPoll: { nowMs: Schema.Number },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type
