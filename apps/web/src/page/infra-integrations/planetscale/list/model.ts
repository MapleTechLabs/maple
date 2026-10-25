import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraPlanetscaleSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"
import { DatabaseList, DatabaseStat, PlanetscaleStatus } from "../data"

// `/infra/planetscale`.

export const SortKey = Schema.Literals([
	"name",
	"branchCount",
	"connectionsAvg",
	"cpuMaxPercent",
	"memMaxPercent",
	"storageUsedPercent",
	"replicaLagMaxSeconds",
])
export type SortKey = typeof SortKey.Type

export const Model = Schema.Struct({
	search: InfraPlanetscaleSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(PlanetscaleStatus, LoadFailure),
	databases: KeyedSchema(DatabaseList, LoadFailure),
	stats: KeyedSchema(Schema.Array(DatabaseStat), LoadFailure),
	/** `null` until a head is clicked: the table's initial sort depends on the metrics state. */
	sort: Schema.NullOr(sortStateOf(SortKey)),
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
	CompletedLoadStatus: result(PlanetscaleStatus),
	CompletedFetchDatabases: result(DatabaseList),
	CompletedFetchStats: result(Schema.Array(DatabaseStat)),
	ClickedRetryStats: {},
	ClickedSort: { key: SortKey },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
