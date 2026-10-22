import { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Overlays from "../overlays"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { IssuePage, ReleasesData } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload. */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** A chip's URL param. */
export const FilterParam = Schema.Literals(["environments", "excludedEnvironments", "services", "impact"])
export type FilterParam = typeof FilterParam.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchReleases: result(ReleasesData),
	CompletedFetchIssues: result(IssuePage),
	CompletedFetchCommits: result(Schema.Array(VcsCommitDetailResponse)),
	CompletedFetchRanges: result(Schema.Array(VcsCommitRangeResponse)),
	PaintedTable: {},
	MeasuredTrack: { width: Schema.Number },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: {},
	ClickedResetTimeRange: {},
	ToggledHealthOption: { name: Schema.String },
	ToggledEnvironment: { name: Schema.String },
	ClickedOnlyEnvironment: { name: Schema.String },
	ClickedExcludeEnvironment: { name: Schema.String },
	ToggledService: { name: Schema.String },
	ClickedClearFilters: {},
	ClickedClearHealthFilter: {},
	RemovedFilterChip: { param: FilterParam },
	ToggledExpanded: { commitSha: Schema.String },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotOverlaysMessage: { message: Overlays.Message },
})
export type Message = typeof Message.Type
