import { Schema } from "effect"
import {
	UserActivityItem,
	UserEventItem,
	UserMcpSessionItem,
	UserProfileItem,
	UserSessionItem,
} from "@maple/domain/http"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { UserDetailSearch } from "../../../route/search"
import * as TimeRangePicker from "../../kit/time-range-picker"

// `/users/$userId`: one end user.

export type Search = typeof UserDetailSearch.Type

/** `getUserProfile`: `null` when nothing in the window and scope carries the user. */
export const ProfileData = Schema.Struct({ profile: Schema.NullOr(UserProfileItem) })
export type ProfileData = typeof ProfileData.Type

/** `getUserActivity`: the tabs' rows and the merged timeline. */
export const ActivityData = Schema.Struct({
	sessions: Schema.Array(UserSessionItem),
	events: Schema.Array(UserEventItem),
	mcpSessions: Schema.Array(UserMcpSessionItem),
	activity: Schema.Array(UserActivityItem),
})
export type ActivityData = typeof ActivityData.Type

export const Model = Schema.Struct({
	userId: Schema.String,
	search: UserDetailSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	profile: KeyedSchema(ProfileData, LoadFailure),
	activity: KeyedSchema(ActivityData, LoadFailure),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
