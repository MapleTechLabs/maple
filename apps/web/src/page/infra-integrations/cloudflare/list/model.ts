import {
	CLOUDFLARE_VIEWS,
	WORKER_SCOPES,
	ZONE_SCOPES,
} from "../../../../components/infra/cloudflare/list-model"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraCloudflareSearch } from "../../../../route/search"
import * as Menu from "../../../../ui/menu"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"
import { PlatformResources, Status, Usage, WorkerRow, ZoneBucket, ZoneRow } from "../data"

// `/infra/cloudflare`.

export const View = Schema.Literals(CLOUDFLARE_VIEWS)
export type View = typeof View.Type

export const ZoneSortKey = Schema.Literals([
	"zoneName",
	"requests",
	"errorRate",
	"clientErrorRate",
	"cacheHitRate",
	"bytes",
	"ttfbP99Ms",
])
export type ZoneSortKey = typeof ZoneSortKey.Type

export const QueueSortKey = Schema.Literals([
	"queueName",
	"backlogMessages",
	"backlogMessagesMax",
	"consumerConcurrency",
])
export type QueueSortKey = typeof QueueSortKey.Type

export const Model = Schema.Struct({
	search: InfraCloudflareSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(Status, LoadFailure),
	usage: KeyedSchema(Usage, LoadFailure),
	zones: KeyedSchema(Schema.Array(ZoneRow), LoadFailure),
	timeseries: KeyedSchema(Schema.Array(ZoneBucket), LoadFailure),
	workers: KeyedSchema(Schema.Array(WorkerRow), LoadFailure),
	platform: KeyedSchema(PlatformResources, LoadFailure),
	zoneSort: sortStateOf(ZoneSortKey),
	queueSort: sortStateOf(QueueSortKey),
	accountMenu: Menu.Model,
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
	CompletedFetchZones: result(Schema.Array(ZoneRow)),
	CompletedFetchTimeseries: result(Schema.Array(ZoneBucket)),
	CompletedFetchWorkers: result(Schema.Array(WorkerRow)),
	CompletedFetchPlatform: result(PlatformResources),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	TickedIngestPoll: {},
	TickedClock: { nowMs: Schema.Number },
	ClickedView: { view: View },
	ClickedScope: { scope: Schema.optional(Schema.Literals([...ZONE_SCOPES, ...WORKER_SCOPES])) },
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ToggledPreviews: {},
	ClickedAccount: { accountId: Schema.optional(Schema.String) },
	ClickedZoneSort: { key: ZoneSortKey },
	ClickedQueueSort: { key: QueueSortKey },
	ClickedRetryStatus: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotAccountMenuMessage: { message: Menu.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotSparklineMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type
