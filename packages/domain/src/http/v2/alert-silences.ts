import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AlertForbiddenError, AlertPersistenceError, AlertValidationError } from "../alerts"
import {
	AlertSilenceNotFoundError,
	AlertSilenceReason,
	AlertSilenceStatus,
	MAX_ALERT_SILENCE_MATCHER_VALUES,
} from "../alert-silences"
import { AlertSilenceId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { AlertMaintenanceWindowPublicId, AlertRulePublicId } from "./resource-ids"

export const AlertSilencePublicId = PublicId(PublicIdPrefixes.alertSilence, AlertSilenceId)

const MatcherValue = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed(), Schema.isMaxLength(200))
const matcherList = <S extends Schema.Top>(item: S, description: string) =>
	Schema.optionalKey(
		Schema.Array(item)
			.check(Schema.isMaxLength(MAX_ALERT_SILENCE_MATCHER_VALUES))
			.annotate({ description }),
	)

export const V2AlertSilenceMatchers = Schema.Struct({
	rule_ids: matcherList(AlertRulePublicId, "Silence these alert rules (`alrt_…`)."),
	tags: matcherList(MatcherValue, "Silence rules carrying any of these tags."),
	services: matcherList(
		MatcherValue,
		"Silence rules whose whole service scope is in this list, and the matching groups of rules grouped by `service.name`. A rule over every service is not silenced by a service list.",
	),
	environments: matcherList(
		MatcherValue,
		"Silence rules whose whole environment scope is in this list, and the matching groups of rules grouped by `deployment.environment`.",
	),
}).annotate({
	identifier: "AlertSilenceMatchers",
	title: "Alert silence matchers",
	description:
		"Which rules the silence covers. Fields combine with AND, values inside a field with OR. At least one value is required.",
})
export type V2AlertSilenceMatchers = Schema.Schema.Type<typeof V2AlertSilenceMatchers>

const alertSilenceExample = {
	id: "sil_9Hq3cW1rN2kLmP7vX4yZtB",
	object: "alert_silence",
	reason: "Deploying checkout v2.3",
	matchers: { services: ["checkout"] },
	status: "active",
	starts_at: "2026-07-15T09:00:00.000Z",
	ends_at: "2026-07-15T10:00:00.000Z",
	maintenance_window_id: null,
	created_by: "user_2abc",
	created_at: "2026-07-15T09:00:00.000Z",
	updated_at: "2026-07-15T09:00:00.000Z",
} as const

export const V2AlertSilence = Schema.Struct({
	id: AlertSilencePublicId,
	object: Schema.Literal("alert_silence").annotate({
		description: 'The object type — always `"alert_silence"`.',
		examples: ["alert_silence"],
	}),
	reason: Schema.String.annotate({
		description: "Why notifications are silenced.",
		examples: ["Deploying checkout v2.3"],
	}),
	matchers: V2AlertSilenceMatchers,
	status: AlertSilenceStatus.annotate({
		description: "`scheduled` before `starts_at`, `active` until `ends_at`, `ended` after.",
		examples: ["active"],
	}),
	starts_at: Timestamp.annotate({ description: "When the silence takes effect." }),
	ends_at: Timestamp.annotate({ description: "When the silence ends. Ending it early moves this to now." }),
	maintenance_window_id: Schema.NullOr(AlertMaintenanceWindowPublicId).annotate({
		description: "The maintenance window (`mw_…`) this silence is one occurrence of, or null.",
	}),
	created_by: Schema.String.annotate({ description: "The user (`user_…`) who created the silence." }),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "AlertSilence",
	title: "Alert Silence",
	description:
		"A window during which matching alert rules keep evaluating and opening incidents, but send no notifications. Held-back notifications are recorded as `silenced` deliveries. When it ends on a still-open incident, the next breaching check sends the page once; a resolve during the silence reaches only destinations paged before it began.",
	examples: [wireExample(alertSilenceExample)],
})
export type V2AlertSilence = Schema.Schema.Type<typeof V2AlertSilence>

const DurationMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 * 24 * 60 })).annotate({
	description: "How long the silence lasts from `starts_at`, in minutes. Use instead of `ends_at`.",
	examples: [60],
})

export const V2AlertSilenceCreateParams = Schema.Struct({
	reason: AlertSilenceReason.annotate({
		description: "Why notifications are silenced.",
		examples: ["Deploying checkout v2.3"],
	}),
	matchers: V2AlertSilenceMatchers,
	starts_at: Schema.optionalKey(
		Timestamp.annotate({ description: "When it takes effect. Defaults to now." }),
	),
	ends_at: Schema.optionalKey(
		Timestamp.annotate({ description: "When it ends. Give this or `duration_minutes`." }),
	),
	duration_minutes: Schema.optionalKey(DurationMinutes),
}).annotate({
	identifier: "AlertSilenceCreateParams",
	title: "Create alert silence",
	description: "A silence lasts at most 30 days. Give exactly one of `ends_at` and `duration_minutes`.",
})
export type V2AlertSilenceCreateParams = Schema.Schema.Type<typeof V2AlertSilenceCreateParams>

export const V2AlertSilenceUpdateParams = Schema.Struct({
	reason: Schema.optionalKey(AlertSilenceReason),
	matchers: Schema.optionalKey(V2AlertSilenceMatchers),
	starts_at: Schema.optionalKey(
		Timestamp.annotate({ description: "Only before the silence has started." }),
	),
	ends_at: Schema.optionalKey(Timestamp.annotate({ description: "Extend or shorten the silence." })),
}).annotate({
	identifier: "AlertSilenceUpdateParams",
	title: "Update alert silence",
	description: "Change an active or scheduled silence. An ended silence cannot be changed.",
})
export type V2AlertSilenceUpdateParams = Schema.Schema.Type<typeof V2AlertSilenceUpdateParams>

const SilencesQuery = Schema.Struct({
	...ListQuery.fields,
	status: Schema.optional(
		AlertSilenceStatus.annotate({
			description: "Only return silences in this status.",
			examples: ["active"],
		}),
	),
}).annotate({
	identifier: "AlertSilenceListQuery",
	title: "Alert silence list query",
	description: "Pagination plus an optional status filter.",
})

const AlertSilenceList = ListOf(V2AlertSilence).annotate({
	identifier: "AlertSilenceList",
	title: "Alert silence list",
	description: "A cursor-paginated page of alert silences, latest ending first.",
})

const [alertForbidden, alertValidation, alertPersistence, alertSilenceNotFound] = publicErrors(
	AlertForbiddenError,
	AlertValidationError,
	AlertPersistenceError,
	AlertSilenceNotFoundError,
)

export class V2AlertSilencesApiGroup extends HttpApiGroup.make("alertSilences")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: SilencesQuery,
			success: AlertSilenceList,
			error: [V2ParameterInvalid.schema, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertSilences",
				summary: "List alert silences",
				description:
					"Returns your organization's alert silences, latest ending first, optionally filtered by `status`. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AlertSilencePublicId },
			success: V2AlertSilence,
			error: [alertSilenceNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAlertSilence",
				summary: "Retrieve an alert silence",
				description:
					"Returns a single alert silence by its `sil_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2AlertSilenceCreateParams,
			success: V2AlertSilence,
			error: [V2ParameterInvalid.schema, alertForbidden, alertValidation, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAlertSilence",
				summary: "Create an alert silence",
				description:
					"Silences notifications for matching rules from `starts_at` (default now) until `ends_at`. Requires a role that can manage alerts and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: AlertSilencePublicId },
			payload: V2AlertSilenceUpdateParams,
			success: V2AlertSilence,
			error: [
				V2ParameterInvalid.schema,
				alertForbidden,
				alertValidation,
				alertPersistence,
				alertSilenceNotFound,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAlertSilence",
				summary: "Update an alert silence",
				description:
					"Changes the reason, matchers or window of an active or scheduled silence. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("end", "/:id/end", {
			params: { id: AlertSilencePublicId },
			success: V2AlertSilence,
			error: [alertForbidden, alertValidation, alertPersistence, alertSilenceNotFound],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "endAlertSilence",
				summary: "End an alert silence",
				description:
					"Ends an active silence now, or cancels a scheduled one. Silences are kept, not deleted, so incident history can still name them. A maintenance window's silence is refused: edit or disable the window. Requires the `alerts:write` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/silences")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Silences",
			description:
				"Maintenance windows for alerting: quiet a deploy or a planned migration without disabling rules. Rules keep evaluating and incidents still open and resolve; only notifications are held back.",
		}),
	) {}
