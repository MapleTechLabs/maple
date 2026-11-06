import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Array as Arr, DateTime, Schema } from "effect"
import {
	AlertForbiddenError,
	AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	AlertPersistenceError,
	AlertValidationError,
} from "../alerts"
import {
	MAX_ONCALL_LAYERS,
	type OnCallLayer,
	type OnCallRestriction,
	type OnCallRotation,
	MAX_ONCALL_PARTICIPANTS,
	MAX_ONCALL_RESTRICTIONS,
	OnCallLocalTime,
	OnCallOverrideNotFoundError,
	OnCallScheduleDescription,
	OnCallScheduleInUseError,
	OnCallScheduleName,
	OnCallScheduleNotFoundError,
	OnCallTimeZone,
	OnCallWeekday,
} from "../oncall-schedules"
import { UserId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { isoTimestamp, wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { EscalationChainPublicId, OnCallOverridePublicId, OnCallSchedulePublicId } from "./resource-ids"

export { OnCallOverridePublicId, OnCallSchedulePublicId } from "./resource-ids"

const ScheduleUserId = UserId.annotate({
	description: "A Maple user id (`user_…`) of a member of your organization.",
})

const HandoffTime = OnCallLocalTime.annotate({
	description: "Local wall-clock time of the handoff in the schedule's time zone, `HH:MM`.",
	examples: ["09:00"],
})

export const V2OnCallRotation = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("daily").annotate({ description: "Hand off every day at `handoff_time`." }),
		handoff_time: HandoffTime,
	}),
	Schema.Struct({
		kind: Schema.Literal("weekly").annotate({
			description: "Hand off once a week on `handoff_weekday` at `handoff_time`.",
		}),
		handoff_weekday: OnCallWeekday,
		handoff_time: HandoffTime,
	}),
	Schema.Struct({
		kind: Schema.Literal("custom").annotate({
			description: "Fixed-length shifts of `length_hours` elapsed hours, from the layer's `starts_at`.",
		}),
		length_hours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 336 })).annotate({
			description: "Shift length in hours, 1 to 336.",
			examples: [12],
		}),
	}),
]).annotate({
	identifier: "OnCallRotation",
	title: "On-call rotation",
	description: "When the layer hands off from one participant to the next.",
})
export type V2OnCallRotation = Schema.Schema.Type<typeof V2OnCallRotation>

export const V2OnCallRestriction = Schema.Struct({
	weekdays: Schema.Array(OnCallWeekday)
		.pipe(Schema.refine(Arr.isReadonlyArrayNonEmpty))
		.check(Schema.isMinLength(1), Schema.isMaxLength(7))
		.annotate({ description: "Days the window starts on." }),
	start_time: OnCallLocalTime.annotate({ description: "Local start time, `HH:MM`.", examples: ["18:00"] }),
	end_time: OnCallLocalTime.annotate({
		description: "Local end time, `HH:MM`. At or before `start_time` crosses midnight.",
		examples: ["08:00"],
	}),
}).annotate({
	identifier: "OnCallRestriction",
	title: "On-call restriction",
	description: "A weekly local window the layer is active in.",
})
export type V2OnCallRestriction = Schema.Schema.Type<typeof V2OnCallRestriction>

export const V2OnCallLayer = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
		description: "Display name, 1 to 100 characters.",
		examples: ["Primary"],
	}),
	participants: Schema.Array(ScheduleUserId)
		.pipe(Schema.refine(Arr.isReadonlyArrayNonEmpty))
		.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ONCALL_PARTICIPANTS))
		.annotate({
			description: `Who rotates through the layer, in order: 1 to ${MAX_ONCALL_PARTICIPANTS} members.`,
		}),
	rotation: V2OnCallRotation,
	starts_at: Timestamp.annotate({
		description: "Rotation anchor: the first participant holds the shift that contains this instant.",
	}),
	restrictions: Schema.optionalKey(
		Schema.Array(V2OnCallRestriction)
			.check(Schema.isMaxLength(MAX_ONCALL_RESTRICTIONS))
			.annotate({
				description: `Weekly windows the layer is limited to, at most ${MAX_ONCALL_RESTRICTIONS}. Omitted or empty means always active.`,
			}),
	),
}).annotate({
	identifier: "OnCallLayer",
	title: "On-call layer",
	description: "One rotation. Later layers sit on top of earlier ones wherever they have someone on call.",
})
export type V2OnCallLayer = Schema.Schema.Type<typeof V2OnCallLayer>

export const V2OnCallLayers = Schema.Array(V2OnCallLayer)
	.pipe(Schema.refine(Arr.isReadonlyArrayNonEmpty))
	.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ONCALL_LAYERS))
	.annotate({ description: `The layers, bottom first: 1 to ${MAX_ONCALL_LAYERS}.` })

const toV2Rotation = (rotation: OnCallRotation): V2OnCallRotation => {
	switch (rotation.kind) {
		case "daily":
			return { kind: "daily", handoff_time: rotation.handoffTime }
		case "weekly":
			return {
				kind: "weekly",
				handoff_weekday: rotation.handoffWeekday,
				handoff_time: rotation.handoffTime,
			}
		case "custom":
			return { kind: "custom", length_hours: rotation.lengthHours }
	}
}

const fromV2Rotation = (rotation: V2OnCallRotation): OnCallRotation => {
	switch (rotation.kind) {
		case "daily":
			return { kind: "daily", handoffTime: rotation.handoff_time }
		case "weekly":
			return {
				kind: "weekly",
				handoffWeekday: rotation.handoff_weekday,
				handoffTime: rotation.handoff_time,
			}
		case "custom":
			return { kind: "custom", lengthHours: rotation.length_hours }
	}
}

const toV2Restriction = (r: OnCallRestriction): V2OnCallRestriction => ({
	weekdays: r.weekdays,
	start_time: r.startTime,
	end_time: r.endTime,
})

const fromV2Restriction = (r: V2OnCallRestriction): OnCallRestriction => ({
	weekdays: r.weekdays,
	startTime: r.start_time,
	endTime: r.end_time,
})

/** A decoded wire timestamp as epoch ms; the schema already proved it parses. */
export const v2TimestampMs = (value: Timestamp): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value))

export const toV2OnCallLayer = (layer: OnCallLayer): V2OnCallLayer => ({
	name: layer.name,
	participants: layer.participants,
	rotation: toV2Rotation(layer.rotation),
	starts_at: isoTimestamp(layer.startsAt),
	...(layer.restrictions === undefined
		? undefined
		: { restrictions: Arr.map(layer.restrictions, toV2Restriction) }),
})

export const fromV2OnCallLayer = (layer: V2OnCallLayer): OnCallLayer => ({
	name: layer.name,
	participants: layer.participants,
	rotation: fromV2Rotation(layer.rotation),
	startsAt: v2TimestampMs(layer.starts_at),
	...(layer.restrictions === undefined
		? undefined
		: { restrictions: Arr.map(layer.restrictions, fromV2Restriction) }),
})

const TimeZone = OnCallTimeZone.annotate({
	description: "IANA time zone that handoffs and restrictions are read in.",
	examples: ["Europe/Berlin"],
})

export const V2OnCallNow = Schema.Struct({
	user_id: UserId,
	starts_at: Timestamp,
	ends_at: Timestamp,
}).annotate({
	identifier: "OnCallNow",
	title: "On call now",
	description: "Who holds the current shift, with its bounds (looked up at most 15 days either side).",
})

const scheduleExample = {
	id: "onc_gQtGH2s65G6a7sJmuayXL6",
	object: "oncall_schedule",
	name: "Checkout primary",
	description: null,
	time_zone: "Europe/Berlin",
	layers: [
		{
			name: "Primary",
			participants: ["user_2Nk8mXqPfR3yZ1aB4cD5eF6g", "user_2Pq9rStUvWxYz0aB1cD2eF3g"],
			rotation: { kind: "weekly", handoff_weekday: "mon", handoff_time: "09:00" },
			starts_at: "2026-11-09T08:00:00.000Z",
		},
	],
	on_call_now: {
		user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
		starts_at: "2026-11-09T08:00:00.000Z",
		ends_at: "2026-11-16T08:00:00.000Z",
	},
	chain_ids: [],
	created_at: "2026-11-06T09:00:00.000Z",
	updated_at: "2026-11-06T09:00:00.000Z",
} as const

export const V2OnCallSchedule = Schema.Struct({
	id: OnCallSchedulePublicId,
	object: Schema.Literal("oncall_schedule").annotate({
		description: 'The object type, always `"oncall_schedule"`.',
		examples: ["oncall_schedule"],
	}),
	name: Schema.String.annotate({ description: "Display name.", examples: ["Checkout primary"] }),
	description: Schema.NullOr(Schema.String).annotate({ description: "Free-form notes, or `null`." }),
	time_zone: Schema.String.annotate({ description: "IANA time zone.", examples: ["Europe/Berlin"] }),
	layers: V2OnCallLayers,
	on_call_now: Schema.NullOr(V2OnCallNow).annotate({
		description: "Who is on call right now, or `null` when nobody is.",
	}),
	chain_ids: Schema.Array(EscalationChainPublicId).annotate({
		description: "Escalation chains (`esc_…`) that page this schedule.",
	}),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "OnCallSchedule",
	title: "On-Call Schedule",
	description:
		"Who is on call when. Each layer rotates its participants; later layers win where they have someone on call, and overrides beat every layer.",
	examples: [wireExample(scheduleExample)],
})
export type V2OnCallSchedule = Schema.Schema.Type<typeof V2OnCallSchedule>

export const V2OnCallScheduleCreateParams = Schema.Struct({
	name: OnCallScheduleName.annotate({ description: "Display name, 1 to 120 characters." }),
	description: Schema.optionalKey(
		Schema.NullOr(OnCallScheduleDescription).annotate({
			description: "Free-form notes, at most 500 characters.",
		}),
	),
	time_zone: TimeZone,
	layers: V2OnCallLayers,
}).annotate({
	identifier: "OnCallScheduleCreateParams",
	title: "Create on-call schedule",
	description: "Every participant must be a member of your organization.",
	examples: [
		wireExample({
			name: scheduleExample.name,
			time_zone: scheduleExample.time_zone,
			layers: scheduleExample.layers,
		}),
	],
})
export type V2OnCallScheduleCreateParams = Schema.Schema.Type<typeof V2OnCallScheduleCreateParams>

export const V2OnCallScheduleUpdateParams = Schema.Struct({
	name: Schema.optionalKey(OnCallScheduleName),
	description: Schema.optionalKey(Schema.NullOr(OnCallScheduleDescription)),
	time_zone: Schema.optionalKey(TimeZone),
	layers: Schema.optionalKey(V2OnCallLayers.annotate({ description: "Replaces every layer." })),
}).annotate({
	identifier: "OnCallScheduleUpdateParams",
	title: "Update on-call schedule",
	description: "Omitted fields are unchanged. Overrides are kept.",
	examples: [wireExample({ time_zone: "America/New_York" })],
})
export type V2OnCallScheduleUpdateParams = Schema.Schema.Type<typeof V2OnCallScheduleUpdateParams>

export const V2OnCallScheduleDeleteResponse = Schema.Struct({
	id: OnCallSchedulePublicId,
	object: Schema.Literal("oncall_schedule").annotate({
		description: 'The object type, always `"oncall_schedule"`.',
	}),
	deleted: Schema.Literal(true).annotate({ description: "Always `true`: the schedule no longer exists." }),
}).annotate({
	identifier: "OnCallScheduleDeleteResponse",
	title: "On-call schedule delete response",
	description: "Confirmation that an on-call schedule and its overrides were deleted.",
	examples: [wireExample({ id: scheduleExample.id, object: "oncall_schedule", deleted: true })],
})
export type V2OnCallScheduleDeleteResponse = Schema.Schema.Type<typeof V2OnCallScheduleDeleteResponse>

export const V2OnCallShift = Schema.Struct({
	user_id: UserId,
	starts_at: Timestamp,
	ends_at: Timestamp,
	source: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("override"),
			override_id: OnCallOverridePublicId,
		}),
		Schema.Struct({
			kind: Schema.Literal("layer"),
			layer_index: Schema.Number.annotate({ description: "Index into `layers`, from 0." }),
		}),
	]).annotate({ description: "What put this person on call: an override or a layer." }),
}).annotate({
	identifier: "OnCallShift",
	title: "On-call shift",
	description: "One person on call over a time range.",
})
export type V2OnCallShift = Schema.Schema.Type<typeof V2OnCallShift>

const shiftExample = {
	user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	starts_at: "2026-11-09T08:00:00.000Z",
	ends_at: "2026-11-16T08:00:00.000Z",
	source: { kind: "layer", layer_index: 0 },
} as const

export const V2OnCallAt = Schema.Struct({
	object: Schema.Literal("oncall").annotate({ description: 'Always `"oncall"`.' }),
	schedule_id: OnCallSchedulePublicId,
	at: Timestamp.annotate({ description: "The instant asked about." }),
	shift: Schema.NullOr(V2OnCallShift).annotate({
		description:
			"The effective shift containing `at`, bounds clamped to 15 days either side, or `null` when nobody is on call.",
	}),
}).annotate({
	identifier: "OnCallAt",
	title: "Who is on call",
	description: "Who is on call for a schedule at one instant.",
	examples: [
		wireExample({
			object: "oncall",
			schedule_id: scheduleExample.id,
			at: "2026-11-12T19:00:00.000Z",
			shift: shiftExample,
		}),
	],
})
export type V2OnCallAt = Schema.Schema.Type<typeof V2OnCallAt>

export const V2OnCallShifts = Schema.Struct({
	object: Schema.Literal("oncall_shifts").annotate({ description: 'Always `"oncall_shifts"`.' }),
	schedule_id: OnCallSchedulePublicId,
	from: Timestamp,
	to: Timestamp.annotate({ description: "The range end, at most 90 days after `from`." }),
	layers: Schema.Array(Schema.Array(V2OnCallShift)).annotate({
		description: "Each layer's own shifts after its restrictions, in layer order.",
	}),
	final: Schema.Array(V2OnCallShift).annotate({
		description: "The effective schedule after layering and overrides. Gaps are times nobody is on call.",
	}),
}).annotate({
	identifier: "OnCallShifts",
	title: "On-call shifts",
	description: "A schedule rendered over a time range.",
	examples: [
		wireExample({
			object: "oncall_shifts",
			schedule_id: scheduleExample.id,
			from: "2026-11-09T08:00:00.000Z",
			to: "2026-11-16T08:00:00.000Z",
			layers: [[shiftExample]],
			final: [shiftExample],
		}),
	],
})
export type V2OnCallShifts = Schema.Schema.Type<typeof V2OnCallShifts>

const overrideExample = {
	id: "ovr_aMadCYFsFjn8nerC3aEWyG",
	object: "oncall_override",
	schedule_id: scheduleExample.id,
	user_id: "user_2Pq9rStUvWxYz0aB1cD2eF3g",
	starts_at: "2026-11-12T17:00:00.000Z",
	ends_at: "2026-11-13T08:00:00.000Z",
	created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	created_at: "2026-11-10T09:00:00.000Z",
} as const

export const V2OnCallOverride = Schema.Struct({
	id: OnCallOverridePublicId,
	object: Schema.Literal("oncall_override").annotate({
		description: 'The object type, always `"oncall_override"`.',
		examples: ["oncall_override"],
	}),
	schedule_id: OnCallSchedulePublicId,
	user_id: UserId.annotate({ description: "Who covers the window." }),
	starts_at: Timestamp,
	ends_at: Timestamp,
	created_by: Schema.String.annotate({ description: "Who created the override." }),
	created_at: Timestamp,
}).annotate({
	identifier: "OnCallOverride",
	title: "On-Call Override",
	description:
		"One person covering a schedule for a window. Beats every layer; the newest overlapping override wins.",
	examples: [wireExample(overrideExample)],
})
export type V2OnCallOverride = Schema.Schema.Type<typeof V2OnCallOverride>

export const V2OnCallOverrideCreateParams = Schema.Struct({
	user_id: ScheduleUserId,
	starts_at: Timestamp,
	ends_at: Timestamp.annotate({
		description: "After `starts_at`, in the future, and at most 90 days after `starts_at`.",
	}),
}).annotate({
	identifier: "OnCallOverrideCreateParams",
	title: "Create on-call override",
	description: "The user must be a member of your organization.",
	examples: [
		wireExample({
			user_id: overrideExample.user_id,
			starts_at: overrideExample.starts_at,
			ends_at: overrideExample.ends_at,
		}),
	],
})
export type V2OnCallOverrideCreateParams = Schema.Schema.Type<typeof V2OnCallOverrideCreateParams>

export const V2OnCallOverrideDeleteResponse = Schema.Struct({
	id: OnCallOverridePublicId,
	object: Schema.Literal("oncall_override").annotate({
		description: 'The object type, always `"oncall_override"`.',
	}),
	deleted: Schema.Literal(true).annotate({ description: "Always `true`: the override no longer exists." }),
}).annotate({
	identifier: "OnCallOverrideDeleteResponse",
	title: "On-call override delete response",
	description: "Confirmation that an override was deleted.",
	examples: [wireExample({ id: overrideExample.id, object: "oncall_override", deleted: true })],
})
export type V2OnCallOverrideDeleteResponse = Schema.Schema.Type<typeof V2OnCallOverrideDeleteResponse>

export const V2OnCallAtQuery = Schema.Struct({
	at: Schema.optional(Timestamp.annotate({ description: "The instant to ask about. Defaults to now." })),
}).annotate({ identifier: "OnCallAtQuery", title: "Who is on call query" })

export const V2OnCallShiftsQuery = Schema.Struct({
	from: Schema.optional(Timestamp.annotate({ description: "Range start. Defaults to now." })),
	to: Schema.optional(
		Timestamp.annotate({
			description: "Range end, after `from`. Defaults to 14 days after `from`; clamped to 90 days.",
		}),
	),
}).annotate({ identifier: "OnCallShiftsQuery", title: "On-call shifts query" })

export const V2OnCallOverridesQuery = Schema.Struct({
	...ListQuery.fields,
	from: Schema.optional(
		Timestamp.annotate({ description: "Only overrides that end after this time. Defaults to now." }),
	),
}).annotate({ identifier: "OnCallOverridesQuery", title: "On-call overrides query" })

const OnCallScheduleList = ListOf(V2OnCallSchedule).annotate({
	identifier: "OnCallScheduleList",
	title: "On-call schedule list",
	description: "A cursor-paginated page of on-call schedules, by name.",
})

const OnCallOverrideList = ListOf(V2OnCallOverride).annotate({
	identifier: "OnCallOverrideList",
	title: "On-call override list",
	description: "A cursor-paginated page of overrides, by start time.",
})

const [
	alertForbidden,
	alertValidation,
	alertPersistence,
	directoryNotConfigured,
	directoryUnavailable,
	scheduleNotFound,
	overrideNotFound,
	scheduleInUse,
] = publicErrors(
	AlertForbiddenError,
	AlertValidationError,
	AlertPersistenceError,
	AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	OnCallScheduleNotFoundError,
	OnCallOverrideNotFoundError,
	OnCallScheduleInUseError,
)

const scheduleId = { id: OnCallSchedulePublicId }

export class V2OnCallSchedulesApiGroup extends HttpApiGroup.make("oncallSchedules")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: OnCallScheduleList,
			error: [V2ParameterInvalid.schema, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listOnCallSchedules",
				summary: "List on-call schedules",
				description:
					"Returns your organization's on-call schedules by name, each with who is on call now. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: scheduleId,
			success: V2OnCallSchedule,
			error: [scheduleNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getOnCallSchedule",
				summary: "Retrieve an on-call schedule",
				description: "Returns a single schedule by its `onc_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2OnCallScheduleCreateParams,
			success: V2OnCallSchedule,
			error: [
				alertForbidden,
				alertValidation,
				alertPersistence,
				directoryNotConfigured,
				directoryUnavailable,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createOnCallSchedule",
				summary: "Create an on-call schedule",
				description:
					"Creates a schedule. Fails with an `invalid_request_error` when a participant is not a member of your organization, or at 50 schedules. Requires a role that can manage alerts and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: scheduleId,
			payload: V2OnCallScheduleUpdateParams,
			success: V2OnCallSchedule,
			error: [
				alertForbidden,
				alertValidation,
				alertPersistence,
				directoryNotConfigured,
				directoryUnavailable,
				scheduleNotFound,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateOnCallSchedule",
				summary: "Update an on-call schedule",
				description:
					"Changes the name, description, time zone or layers. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: scheduleId,
			success: V2OnCallScheduleDeleteResponse,
			error: [alertForbidden, alertPersistence, scheduleNotFound, scheduleInUse],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteOnCallSchedule",
				summary: "Delete an on-call schedule",
				description:
					"Deletes a schedule and its overrides. Fails with a `conflict_error` while an escalation chain pages it. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("oncall", "/:id/oncall", {
			params: scheduleId,
			query: V2OnCallAtQuery,
			success: V2OnCallAt,
			error: [V2ParameterInvalid.schema, scheduleNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getOnCall",
				summary: "Who is on call",
				description:
					"Returns who is on call for the schedule at `at` (default now), with the shift's bounds. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("shifts", "/:id/shifts", {
			params: scheduleId,
			query: V2OnCallShiftsQuery,
			success: V2OnCallShifts,
			error: [V2ParameterInvalid.schema, alertValidation, scheduleNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listOnCallShifts",
				summary: "Render on-call shifts",
				description:
					"Renders the schedule over `from` to `to`: each layer's shifts and the effective shifts after overrides. Ranges past 90 days are cut to 90. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listOverrides", "/:id/overrides", {
			params: scheduleId,
			query: V2OnCallOverridesQuery,
			success: OnCallOverrideList,
			error: [V2ParameterInvalid.schema, scheduleNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listOnCallOverrides",
				summary: "List on-call overrides",
				description:
					"Returns the schedule's overrides that end after `from` (default now), by start time. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("createOverride", "/:id/overrides", {
			params: scheduleId,
			payload: V2OnCallOverrideCreateParams,
			success: V2OnCallOverride,
			error: [
				alertForbidden,
				alertValidation,
				alertPersistence,
				directoryNotConfigured,
				directoryUnavailable,
				scheduleNotFound,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createOnCallOverride",
				summary: "Create an on-call override",
				description:
					"Puts one member on call for a window, over every layer. At most 90 days long, not entirely in the past, and 500 upcoming overrides per schedule. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("deleteOverride", "/:id/overrides/:override_id", {
			params: { id: OnCallSchedulePublicId, override_id: OnCallOverridePublicId },
			success: V2OnCallOverrideDeleteResponse,
			error: [alertForbidden, alertPersistence, scheduleNotFound, overrideNotFound],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteOnCallOverride",
				summary: "Delete an on-call override",
				description:
					"Deletes an override; the layers decide again. Requires the `alerts:write` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/oncall_schedules")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "On-Call Schedules",
			description:
				"Who is on call when: layered rotations in a time zone, with overrides for swaps and cover.",
		}),
	) {}
