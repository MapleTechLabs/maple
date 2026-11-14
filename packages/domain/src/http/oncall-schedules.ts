import { DateTime, Option, Schema } from "effect"
import {
	EscalationChainId,
	IsoDateTimeString,
	OnCallOverrideId,
	OnCallScheduleId,
	UserId,
} from "@maple/primitives"
import { HttpTaggedError } from "./error-policy"

import { EpochMillis, OnCallLayers } from "../oncall-schedules"
export {
	MAX_ONCALL_FUTURE_OVERRIDES,
	MAX_ONCALL_LAYERS,
	MAX_ONCALL_OVERRIDE_MS,
	MAX_ONCALL_PARTICIPANTS,
	MAX_ONCALL_RESTRICTIONS,
	MAX_ONCALL_SCHEDULES_PER_ORG,
	ONCALL_LOOKAROUND_MS,
	OnCallCustomRotation,
	OnCallDailyRotation,
	OnCallLayer,
	OnCallLayers,
	OnCallLocalTime,
	OnCallRestriction,
	OnCallRotation,
	OnCallWeekday,
	OnCallWeeklyRotation,
} from "../oncall-schedules"

/** An IANA zone the runtime can resolve. */
export const OnCallTimeZone = Schema.String.check(
	Schema.isMaxLength(64),
	Schema.makeFilter((zone: string) => Option.isSome(DateTime.zoneMakeNamed(zone)) || "unknown time zone", {
		identifier: "OnCallTimeZone",
	}),
)

/** Later layers sit on top: where a higher layer has someone on call, it wins. */
export const OnCallScheduleConfig = Schema.Struct({
	timeZone: OnCallTimeZone,
	layers: OnCallLayers,
})
export type OnCallScheduleConfig = Schema.Schema.Type<typeof OnCallScheduleConfig>

/** Beats every layer; among overlapping overrides the most recently created wins. */
export const OnCallOverride = Schema.Struct({
	id: OnCallOverrideId,
	userId: UserId,
	startsAt: EpochMillis,
	endsAt: EpochMillis,
	createdAt: EpochMillis,
}).check(
	Schema.makeFilter((o) => o.endsAt > o.startsAt || "endsAt must be after startsAt", {
		identifier: "OnCallOverrideRange",
	}),
)
export type OnCallOverride = Schema.Schema.Type<typeof OnCallOverride>

export const OnCallScheduleName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isTrimmed(),
	Schema.isMaxLength(120),
)
export const OnCallScheduleDescription = Schema.String.check(Schema.isMaxLength(500))

/** Who holds the effective shift at an instant, and its bounds. */
export class OnCallNow extends Schema.Class<OnCallNow>("OnCallNow")({
	userId: UserId,
	startsAt: IsoDateTimeString,
	endsAt: IsoDateTimeString,
}) {}

export class OnCallScheduleDocument extends Schema.Class<OnCallScheduleDocument>("OnCallScheduleDocument")({
	id: OnCallScheduleId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	timeZone: Schema.String,
	layers: OnCallLayers,
	/** Null when nobody is on call right now. */
	onCallNow: Schema.NullOr(OnCallNow),
	/** Escalation chains that page this schedule. */
	chainIds: Schema.Array(EscalationChainId),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class OnCallSchedulesListResponse extends Schema.Class<OnCallSchedulesListResponse>(
	"OnCallSchedulesListResponse",
)({
	schedules: Schema.Array(OnCallScheduleDocument),
}) {}

export class OnCallScheduleCreateRequest extends Schema.Class<OnCallScheduleCreateRequest>(
	"OnCallScheduleCreateRequest",
)({
	name: OnCallScheduleName,
	description: Schema.optionalKey(Schema.NullOr(OnCallScheduleDescription)),
	timeZone: OnCallTimeZone,
	layers: OnCallLayers,
}) {}

export class OnCallScheduleUpdateRequest extends Schema.Class<OnCallScheduleUpdateRequest>(
	"OnCallScheduleUpdateRequest",
)({
	name: Schema.optionalKey(OnCallScheduleName),
	description: Schema.optionalKey(Schema.NullOr(OnCallScheduleDescription)),
	timeZone: Schema.optionalKey(OnCallTimeZone),
	layers: Schema.optionalKey(OnCallLayers),
}) {}

export class OnCallOverrideDocument extends Schema.Class<OnCallOverrideDocument>("OnCallOverrideDocument")({
	id: OnCallOverrideId,
	scheduleId: OnCallScheduleId,
	userId: UserId,
	startsAt: IsoDateTimeString,
	endsAt: IsoDateTimeString,
	createdBy: Schema.String,
	createdAt: IsoDateTimeString,
}) {}

export class OnCallOverridesListResponse extends Schema.Class<OnCallOverridesListResponse>(
	"OnCallOverridesListResponse",
)({
	overrides: Schema.Array(OnCallOverrideDocument),
}) {}

/** Times in epoch milliseconds. */
export class OnCallOverrideCreateRequest extends Schema.Class<OnCallOverrideCreateRequest>(
	"OnCallOverrideCreateRequest",
)({
	userId: UserId,
	startsAt: EpochMillis,
	endsAt: EpochMillis,
}) {}

export const OnCallShiftSource = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("override"), overrideId: OnCallOverrideId }),
	Schema.Struct({ kind: Schema.Literal("layer"), layerIndex: Schema.Number }),
])
export type OnCallShiftSource = Schema.Schema.Type<typeof OnCallShiftSource>

export class OnCallShiftDocument extends Schema.Class<OnCallShiftDocument>("OnCallShiftDocument")({
	userId: UserId,
	startsAt: IsoDateTimeString,
	endsAt: IsoDateTimeString,
	source: OnCallShiftSource,
}) {}

export class OnCallAtResponse extends Schema.Class<OnCallAtResponse>("OnCallAtResponse")({
	at: IsoDateTimeString,
	/** Null is a gap: nobody is on call. */
	shift: Schema.NullOr(OnCallShiftDocument),
}) {}

export class OnCallShiftsResponse extends Schema.Class<OnCallShiftsResponse>("OnCallShiftsResponse")({
	from: IsoDateTimeString,
	/** The range end after the 90-day render cap. */
	to: IsoDateTimeString,
	/** Each layer's own shifts after its restrictions. */
	layers: Schema.Array(Schema.Array(OnCallShiftDocument)),
	/** The effective schedule after layering and overrides. */
	final: Schema.Array(OnCallShiftDocument),
}) {}

export class OnCallScheduleNotFoundError extends HttpTaggedError<OnCallScheduleNotFoundError>()(
	"@maple/http/errors/OnCallScheduleNotFoundError",
	{ message: Schema.String, scheduleId: OnCallScheduleId },
	{
		status: 404,
		code: "oncall_schedule_not_found",
		title: "On-call schedule not found",
		message: "No such on-call schedule.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class OnCallOverrideNotFoundError extends HttpTaggedError<OnCallOverrideNotFoundError>()(
	"@maple/http/errors/OnCallOverrideNotFoundError",
	{ message: Schema.String, overrideId: OnCallOverrideId },
	{
		status: 404,
		code: "oncall_override_not_found",
		title: "On-call override not found",
		message: "No such on-call override.",
		param: "override_id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class OnCallScheduleInUseError extends HttpTaggedError<OnCallScheduleInUseError>()(
	"@maple/http/errors/OnCallScheduleInUseError",
	{
		message: Schema.String,
		scheduleId: OnCallScheduleId,
		chainIds: Schema.Array(EscalationChainId),
		chainNames: Schema.Array(Schema.String),
	},
	{
		status: 409,
		code: "oncall_schedule_in_use",
		title: "On-call schedule is in use",
		message: "The on-call schedule is paged by one or more escalation chains.",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}
