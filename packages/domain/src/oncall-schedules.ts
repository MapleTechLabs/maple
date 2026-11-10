// Stored shapes shared by the HTTP contract (`./http/oncall-schedules.ts`) and the Postgres tables.

import { UserId } from "@maple/primitives"
import { Schema } from "effect"

export const MAX_ONCALL_LAYERS = 5
export const MAX_ONCALL_PARTICIPANTS = 50
export const MAX_ONCALL_RESTRICTIONS = 7
export const MAX_ONCALL_SCHEDULES_PER_ORG = 50
/** Overrides that have not ended yet, per schedule. */
export const MAX_ONCALL_FUTURE_OVERRIDES = 500
export const MAX_ONCALL_OVERRIDE_MS = 90 * 86_400_000
/** Who is on call at an instant is resolved within this distance of it; shift bounds clamp to it. */
export const ONCALL_LOOKAROUND_MS = 15 * 86_400_000

/** A local wall-clock time, "00:00" through "23:59". */
export const OnCallLocalTime = Schema.String.check(
	Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/u, { identifier: "OnCallLocalTime" }),
)
export type OnCallLocalTime = Schema.Schema.Type<typeof OnCallLocalTime>

export const OnCallWeekday = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
export type OnCallWeekday = Schema.Schema.Type<typeof OnCallWeekday>

export const EpochMillis = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const OnCallDailyRotation = Schema.Struct({
	kind: Schema.Literal("daily"),
	handoffTime: OnCallLocalTime,
})

export const OnCallWeeklyRotation = Schema.Struct({
	kind: Schema.Literal("weekly"),
	handoffWeekday: OnCallWeekday,
	handoffTime: OnCallLocalTime,
})

/** Fixed-length shifts in elapsed hours, anchored at the layer's `startsAt`. */
export const OnCallCustomRotation = Schema.Struct({
	kind: Schema.Literal("custom"),
	lengthHours: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 336 })),
})

export const OnCallRotation = Schema.Union([OnCallDailyRotation, OnCallWeeklyRotation, OnCallCustomRotation])
export type OnCallRotation = Schema.Schema.Type<typeof OnCallRotation>

/** A weekly local window; `endTime <= startTime` crosses midnight into the next day. */
export const OnCallRestriction = Schema.Struct({
	weekdays: Schema.NonEmptyArray(OnCallWeekday).check(Schema.isMaxLength(7)),
	startTime: OnCallLocalTime,
	endTime: OnCallLocalTime,
})
export type OnCallRestriction = Schema.Schema.Type<typeof OnCallRestriction>

export const OnCallLayer = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	participants: Schema.NonEmptyArray(UserId).check(Schema.isMaxLength(MAX_ONCALL_PARTICIPANTS)),
	rotation: OnCallRotation,
	/** Rotation anchor: participant 0 holds the shift containing this instant. */
	startsAt: EpochMillis,
	/** Absent or empty means the layer is always active. */
	restrictions: Schema.optionalKey(
		Schema.Array(OnCallRestriction).check(Schema.isMaxLength(MAX_ONCALL_RESTRICTIONS)),
	),
})
export type OnCallLayer = Schema.Schema.Type<typeof OnCallLayer>

export const OnCallLayers = Schema.NonEmptyArray(OnCallLayer).check(Schema.isMaxLength(MAX_ONCALL_LAYERS))
export type OnCallLayers = Schema.Schema.Type<typeof OnCallLayers>
