import { Schema } from "effect"
import { UserListItem, UsersGroupItem, UsersGroupOption } from "@maple/domain/http"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { TimeWindow } from "../../../data/time-range"
import { UsersSearch } from "../../../route/search"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The `/users` directory.

export type Search = typeof UsersSearch.Type

/** One `listUsers` answer: the window's users under the filters, the latest seen first. */
export const UsersPage = Schema.Struct({ users: Schema.Array(UserListItem) })
export type UsersPage = typeof UsersPage.Type

/** One `listUserGroups` answer: the window's groups under the filters, the largest first. */
export const UsersGroupsPage = Schema.Struct({
	groups: Schema.Array(UsersGroupItem),
	truncated: Schema.Boolean,
})
export type UsersGroupsPage = typeof UsersGroupsPage.Type

const FacetItem = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `getUsersFacets`: the rail's counts and the summary strip. */
export const UsersFacetsData = Schema.Struct({
	namespaces: Schema.Array(FacetItem),
	groups: Schema.Array(UsersGroupOption),
	withErrors: Schema.Number,
	withReplay: Schema.Number,
	identified: Schema.Number,
	activeToday: Schema.Number,
	anonymousVisitors: Schema.Number,
})
export type UsersFacetsData = typeof UsersFacetsData.Type

export const Model = Schema.Struct({
	search: UsersSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	list: KeyedSchema(UsersPage, LoadFailure),
	groups: KeyedSchema(UsersGroupsPage, LoadFailure),
	facets: KeyedSchema(UsersFacetsData, LoadFailure),
	presence: SignalPresenceData.schema,
	/** The toolbar search: what is typed, and the debounce run that may still commit it. */
	query: Schema.String,
	queryGeneration: Schema.Number,
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** The empty directory's agent prompt copy state. */
	promptCopy: CopyButton.Model,
})
export type Model = typeof Model.Type
