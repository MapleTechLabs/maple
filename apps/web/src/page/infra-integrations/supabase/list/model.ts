import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraSupabaseSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { sortStateOf } from "../../../kit/table-sort"
import { SupabaseProjectRow, SupabaseStatus } from "../model"

// `/infra/supabase`.

export const SortKey = Schema.Literals(["displayName", "peak", "dbSize", "connectionsMax", "lastSeen"])
export type SortKey = typeof SortKey.Type

export const Model = Schema.Struct({
	search: InfraSupabaseSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(SupabaseStatus, LoadFailure),
	projects: KeyedSchema(Schema.Array(SupabaseProjectRow), LoadFailure),
	sort: sortStateOf(SortKey),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
