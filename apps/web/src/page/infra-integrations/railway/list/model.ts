import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraRailwaySearch } from "../../../../route/search"
import * as Tooltip from "../../../../ui/tooltip"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"
import { RailwayServiceRow, RailwayStatus } from "../model"

// `/infra/railway`.

export const SortKey = Schema.Literals([
	"displayName",
	"cpuMax",
	"memoryMax",
	"peakOfLimit",
	"replicas",
	"lastSeen",
])
export type SortKey = typeof SortKey.Type

export const Model = Schema.Struct({
	search: InfraRailwaySearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(RailwayStatus, LoadFailure),
	services: KeyedSchema(Schema.Array(RailwayServiceRow), LoadFailure),
	sort: sortStateOf(SortKey),
	rowTooltip: Tooltip.Model,
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
