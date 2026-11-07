import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SignalPresences } from "@maple/views/data/signal-presence"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { TimeWindow } from "../../../data/time-range"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { UsersFacetsData, UsersGroupsPage, UsersPage } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchUsers: result(UsersPage),
	CompletedFetchGroups: result(UsersGroupsPage),
	/** `null` lists users, `group` one row per group. */
	ClickedGroupBy: { groupBy: Schema.NullOr(Schema.Literal("group")) },
	CompletedFetchFacets: result(UsersFacetsData),
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	ClickedRetry: {},
	ChangedQuery: { value: Schema.String },
	CompletedQueryDebounce: { generation: Schema.Number },
	ClickedClearQuery: {},
	ToggledErrors: {},
	ToggledReplay: {},
	ToggledNamespace: { name: Schema.String },
	ToggledGroup: { name: Schema.String },
	ClickedClearFilters: {},
	/** The filtered empty state's clear: the search and the typed draft go too. */
	ClickedClearSearchAndFilters: {},
	ClickedClearNamespacePin: {},
	/** The empty directory's "Build with your agent" prompt. */
	GotPromptCopyMessage: { message: CopyButton.Message },
	/** The empty directory's way out of a quiet window. */
	ClickedWidenRange: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type
