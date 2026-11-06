/** Output schemas for the on-call schedule MCP tools. */
import { Schema } from "effect"

const NullableString = Schema.NullOr(Schema.String)

export const OnCallPersonRow = Schema.Struct({
	userId: Schema.String,
	/** Null when the member directory has no name for the user. */
	name: NullableString,
})

export const OnCallLayerRow = Schema.Struct({
	name: Schema.String,
	participants: Schema.Array(OnCallPersonRow),
	/** e.g. `weekly, Monday 09:00`. */
	rotation: Schema.String,
	startsAt: Schema.String,
	/** e.g. `mon,tue 18:00-08:00`; empty means always active. */
	restrictions: Schema.Array(Schema.String),
})

export const OnCallShiftRow = Schema.Struct({
	user: OnCallPersonRow,
	startsAt: Schema.String,
	endsAt: Schema.String,
	/** `override` or `layer`. */
	source: Schema.String,
	/** The layer's name when a layer put the person on call. */
	layerName: NullableString,
	overrideId: NullableString,
})

export const OnCallScheduleRow = Schema.Struct({
	id: Schema.String,
	/** The same schedule's id in the REST API (`onc_…`). */
	publicId: Schema.String,
	name: Schema.String,
	description: NullableString,
	timeZone: Schema.String,
	layers: Schema.Array(OnCallLayerRow),
	onCallNow: Schema.NullOr(
		Schema.Struct({ user: OnCallPersonRow, startsAt: Schema.String, endsAt: Schema.String }),
	),
	chainIds: Schema.Array(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
})

export const ListOnCallSchedulesOutput = Schema.Struct({
	schedules: Schema.Array(OnCallScheduleRow),
	total: Schema.Number,
})

export const WhoIsOnCallOutput = Schema.Struct({
	scheduleId: Schema.String,
	scheduleName: Schema.String,
	timeZone: Schema.String,
	at: Schema.String,
	/** Null is a gap: nobody is on call. */
	onCall: Schema.NullOr(OnCallShiftRow),
	/** The next shift after this one within two weeks, if any. */
	next: Schema.NullOr(OnCallShiftRow),
})

export const OnCallScheduleMutationOutput = Schema.Struct({ schedule: OnCallScheduleRow })

export const DeleteOnCallScheduleOutput = Schema.Struct({ id: Schema.String, name: Schema.String })

export const OnCallOverrideRow = Schema.Struct({
	id: Schema.String,
	/** The REST id (`ovr_…`). */
	publicId: Schema.String,
	scheduleId: Schema.String,
	user: OnCallPersonRow,
	startsAt: Schema.String,
	endsAt: Schema.String,
})

export const OnCallOverrideMutationOutput = Schema.Struct({
	scheduleName: Schema.String,
	override: OnCallOverrideRow,
})

export const DeleteOnCallOverrideOutput = Schema.Struct({
	id: Schema.String,
	scheduleId: Schema.String,
	scheduleName: Schema.String,
})
