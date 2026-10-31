import { SupabaseLogIssuesResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraSupabaseSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { SupabaseFleetInsights, SupabaseProjectRow, SupabaseStatus } from "../model"

// `/infra/supabase`.

export const Model = Schema.Struct({
	search: InfraSupabaseSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: KeyedSchema(SupabaseStatus, LoadFailure),
	projects: KeyedSchema(Schema.Array(SupabaseProjectRow), LoadFailure),
	/** Every project's recurring WARN+ log messages in the window. */
	issues: KeyedSchema(SupabaseLogIssuesResponse, LoadFailure),
	/** The first projects' advisors, read concurrently. */
	insights: KeyedSchema(SupabaseFleetInsights, LoadFailure),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
