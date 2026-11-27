import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { OrgId, UserId } from "@maple/primitives"
import { AlertPersistenceError } from "../alerts"
import { EndpointAccess, requires } from "../endpoint-access"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2OnCallGap } from "./oncall-schedules"
import { publicError } from "./public-error"
import { OnCallSchedulePublicId } from "./resource-ids"

/**
 * Everything a phone asks about on-call, in one read: who has each schedule now, who covers the days
 * ahead, where nobody does, and the caller's own shifts. Without it the app needs the schedule list
 * plus a shifts call per schedule, and a widget gets one request per timeline.
 *
 * Served twice with one shape: under `/v2/alerts` for the app, and under `/v2/widget_summary` so a
 * widget's device credential (`widget_summary:read`) reaches it and nothing else about alerts.
 */

/**
 * A shift as the overview carries it. Flatter than `OnCallShift` on purpose: the phone only asks
 * whether an override put the person there, and its generated client decodes a boolean more safely
 * than a union that may grow.
 */
export const V2OnCallOverviewShift = Schema.Struct({
	user_id: UserId,
	starts_at: Timestamp,
	ends_at: Timestamp,
	is_override: Schema.Boolean.annotate({
		description: "An override put this person on call, not the rotation.",
	}),
	continues: Schema.Boolean.annotate({
		description:
			"The person is still on call at `ends_at`: the window stops there, nobody takes over. Never read such an end as a handoff.",
	}),
}).annotate({
	identifier: "OnCallOverviewShift",
	title: "On-call overview shift",
	description: "One person on call over a time range.",
})
export type V2OnCallOverviewShift = Schema.Schema.Type<typeof V2OnCallOverviewShift>

export const V2OnCallOverviewSchedule = Schema.Struct({
	id: OnCallSchedulePublicId,
	name: Schema.String.annotate({ examples: ["Checkout primary"] }),
	time_zone: Schema.String.annotate({ description: "IANA time zone.", examples: ["Europe/Berlin"] }),
	rotation_summary: Schema.String.annotate({
		description:
			"How the schedule rotates, as one line for a header. A schedule with several layers says how many.",
		examples: ["Weekly, hands off Mon 09:00", "Daily, hands off 09:00", "Every 12 hours", "3 layers"],
	}),
	on_call_now: Schema.NullOr(V2OnCallOverviewShift).annotate({
		description:
			"The stretch that holds now, or `null` when nobody is on call. Back-to-back turns of one person are one stretch, so `ends_at` is when someone else takes over or coverage stops; with `continues` set, that is more than 60 days away.",
	}),
	next: Schema.NullOr(V2OnCallOverviewShift).annotate({
		description:
			"The shift that follows `on_call_now` (or the first one ahead when nobody is on call), or `null` when none starts inside the 14 day window.",
	}),
	shifts: Schema.Array(V2OnCallOverviewShift).annotate({
		description:
			"The effective shifts from now to `schedule_window_ends_at`, earliest first, cut at the window's end. The first may have started before now.",
	}),
	coverage_gaps: Schema.Array(V2OnCallGap).annotate({
		description: "Every stretch of the window when nobody is on call, earliest first.",
	}),
}).annotate({
	identifier: "OnCallOverviewSchedule",
	title: "On-call overview schedule",
	description: "One schedule as a phone draws it.",
})
export type V2OnCallOverviewSchedule = Schema.Schema.Type<typeof V2OnCallOverviewSchedule>

export const V2OnCallMyShift = Schema.Struct({
	schedule_id: OnCallSchedulePublicId,
	schedule_name: Schema.String,
	starts_at: Timestamp,
	ends_at: Timestamp.annotate({
		description: "When the shift ends, cut at 60 days from now for a shift that runs past it.",
	}),
	is_override: Schema.Boolean.annotate({
		description: "The shift comes from an override, not the rotation.",
	}),
	continues: Schema.Boolean.annotate({
		description: "The shift runs past the 60 day window: `ends_at` is the window's end, not a handoff.",
	}),
}).annotate({
	identifier: "OnCallMyShift",
	title: "My on-call shift",
	description: "One of the calling user's own shifts.",
})
export type V2OnCallMyShift = Schema.Schema.Type<typeof V2OnCallMyShift>

export const V2OnCallPerson = Schema.Struct({
	user_id: UserId,
	name: Schema.String,
}).annotate({
	identifier: "OnCallPerson",
	title: "On-call person",
	description: "A display name for a user id the overview mentions.",
})

const exampleShift = {
	user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	starts_at: "2026-11-23T08:00:00.000Z",
	ends_at: "2026-11-30T08:00:00.000Z",
	is_override: false,
	continues: false,
} as const

export const V2OnCallOverview = Schema.Struct({
	object: Schema.Literal("oncall_overview").annotate({ description: 'Always `"oncall_overview"`.' }),
	generated_at: Timestamp,
	organization_id: OrgId,
	user_id: UserId.annotate({ description: "The calling user, whose shifts `my_shifts` lists." }),
	schedule_window_ends_at: Timestamp.annotate({
		description: "Where each schedule's `shifts` and `coverage_gaps` stop: 14 days from now.",
	}),
	schedules: Schema.Array(V2OnCallOverviewSchedule).annotate({
		description: "Every schedule of the organization, by name.",
	}),
	my_shifts: Schema.Array(V2OnCallMyShift).annotate({
		description:
			"The calling user's shifts over the next 60 days across every schedule, earliest first (at most 20). One that has started is the shift they are on now.",
	}),
	people: Schema.Array(V2OnCallPerson).annotate({
		description:
			"Names for the user ids above. A member without a name, or a deployment without a member directory, has no entry.",
	}),
}).annotate({
	identifier: "OnCallOverview",
	title: "On-call overview",
	description: "Who is on call across the organization, and when the calling user is.",
	examples: [
		wireExample({
			object: "oncall_overview",
			generated_at: "2026-11-27T01:14:00.000Z",
			organization_id: "org_2abcDEF",
			user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
			schedule_window_ends_at: "2026-12-11T01:14:00.000Z",
			schedules: [
				{
					id: "onc_gQtGH2s65G6a7sJmuayXL6",
					name: "Checkout primary",
					time_zone: "Europe/Berlin",
					rotation_summary: "Weekly, hands off Mon 09:00",
					on_call_now: exampleShift,
					next: {
						user_id: "user_2Pq9rStUvWxYz0aB1cD2eF3g",
						starts_at: "2026-11-30T08:00:00.000Z",
						ends_at: "2026-12-07T08:00:00.000Z",
						is_override: false,
						continues: false,
					},
					shifts: [exampleShift],
					coverage_gaps: [],
				},
			],
			my_shifts: [
				{
					schedule_id: "onc_gQtGH2s65G6a7sJmuayXL6",
					schedule_name: "Checkout primary",
					starts_at: "2026-11-23T08:00:00.000Z",
					ends_at: "2026-11-30T08:00:00.000Z",
					is_override: false,
					continues: false,
				},
			],
			people: [{ user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g", name: "Dana Kim" }],
		}),
	],
})
export type V2OnCallOverview = Schema.Schema.Type<typeof V2OnCallOverview>

const alertPersistence = publicError(AlertPersistenceError)

export class V2OnCallOverviewApiGroup extends HttpApiGroup.make("oncallOverview")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2OnCallOverview,
			error: [alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getOnCallOverview",
				summary: "Who is on call, and when you are",
				description:
					"Returns who is on call on every schedule, each schedule's next 14 days with its coverage gaps, and the calling user's own shifts over the next 60 days. Requires the `alerts:read` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/oncall_overview")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "On-Call Overview",
			description: "Who is on call across every schedule, and when the calling user is, in one read.",
		}),
	)
	// Stated, not left to the GET default: it names who is on call across the organization.
	.annotate(EndpointAccess, requires("telemetry:read")) {}

export class V2WidgetOnCallApiGroup extends HttpApiGroup.make("widgetOnCall")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2OnCallOverview,
			error: [alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getWidgetOnCall",
				summary: "Who is on call, for a widget",
				description:
					"The same document as `GET /v2/alerts/oncall_overview`, for the user a widget's credential belongs to. Requires the `widget_summary:read` scope.",
			}),
		),
	)
	.prefix("/v2/widget_summary/oncall")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Widget On-Call",
			description:
				"What the Maple mobile On call and Schedule widgets read. In the widget's own scope family so a device credential reaches it without reaching the rest of the alerts API.",
		}),
	)
	.annotate(EndpointAccess, requires("telemetry:read")) {}
