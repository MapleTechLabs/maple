import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AlertIncidentNotFoundError, AlertIncidentResolvedError, AlertPersistenceError } from "../alerts"
import {
	AlertComparator,
	AlertNotificationEventType,
	AlertIncidentAckSource,
	AlertIncidentEventType,
	AlertIncidentHoldReason,
	AlertIncidentStatus,
	AlertSeverity,
	AlertSignalType,
} from "../alerts"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicError } from "./public-error"
import { UserId } from "../../primitives"
import {
	AlertIncidentEventPublicId,
	AlertIncidentPublicId,
	AlertRulePublicId,
	AnomalyIncidentPublicId,
	ErrorIssuePublicId,
} from "./resource-ids"
import { AlertSilencePublicId } from "./alert-silences"

const alertIncidentExample = {
	id: "inc_tC4d9V79DCDzgbGKhAnff9",
	object: "alert_incident",
	rule_id: "alrt_gU26thvJECdQvu54Ad9jiz",
	rule_name: "Checkout error rate",
	group_key: null,
	signal_type: "error_rate",
	severity: "critical",
	peak_severity: "critical",
	status: "open",
	comparator: "gt",
	threshold: 0.05,
	threshold_upper: null,
	first_triggered_at: "2026-07-15T09:10:00.000Z",
	last_triggered_at: "2026-07-15T09:40:00.000Z",
	resolved_at: null,
	last_observed_value: 0.09,
	last_sample_count: 132,
	dedupe_key: "alrt_gU26thvJECdQvu54Ad9jiz:__total__",
	last_delivered_event_type: "trigger",
	last_notified_at: "2026-07-15T09:10:05.000Z",
	hold_reason: null,
	held_since: null,
	acknowledged_at: "2026-07-15T09:14:02.000Z",
	acknowledged_by: { user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g", name: "Dana Kim" },
	acknowledged_via: "slack",
	error_issue_id: null,
	silence_id: null,
	silenced_at: null,
} as const

const V2AlertIncidentActor = Schema.Struct({
	user_id: Schema.NullOr(UserId).annotate({
		description: "The Maple user, or `null` for a chat account not linked to one.",
	}),
	name: Schema.NullOr(Schema.String).annotate({
		description: "Display name as the source reported it, or `null` when none was available.",
		examples: ["Dana Kim"],
	}),
}).annotate({ identifier: "AlertIncidentActor", title: "Alert incident actor" })

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2AlertIncident = Schema.Struct({
	id: AlertIncidentPublicId,
	object: Schema.Literal("alert_incident").annotate({
		description: 'The object type — always `"alert_incident"`.',
		examples: ["alert_incident"],
	}),
	rule_id: AlertRulePublicId.annotate({
		description: "The alert rule (`alrt_…`) that opened this incident.",
	}),
	rule_name: Schema.String.annotate({
		description: "Name of the rule at the time the incident was recorded.",
		examples: ["Checkout error rate"],
	}),
	group_key: Schema.NullOr(Schema.String).annotate({
		description: "The breaching group for grouped rules, or `null` for ungrouped rules.",
	}),
	signal_type: AlertSignalType.annotate({
		description: "The signal the rule measures.",
		examples: ["error_rate"],
	}),
	severity: AlertSeverity.annotate({
		description:
			"Current severity: `warning` or `critical`. Moves when a rule with severity tiers escalates or de-escalates.",
		examples: ["critical"],
	}),
	peak_severity: Schema.NullOr(AlertSeverity).annotate({
		description: "Highest severity the incident reached, or `null` on incidents opened before tiers.",
		examples: ["critical"],
	}),
	status: AlertIncidentStatus.annotate({
		description:
			"`open` while the breach persists; `resolved` once enough consecutive healthy checks are observed. Incident resolution is scheduler-driven — incidents cannot be closed via the API.",
		examples: ["open"],
	}),
	comparator: AlertComparator,
	threshold: Schema.Number.annotate({
		description: "The rule threshold at the time the incident opened.",
		examples: [0.05],
	}),
	threshold_upper: Schema.NullOr(Schema.Number),
	first_triggered_at: Timestamp.annotate({ description: "When the incident opened." }),
	last_triggered_at: Timestamp.annotate({ description: "When the breach was most recently observed." }),
	resolved_at: Schema.NullOr(Timestamp).annotate({
		description: "When the incident resolved, or `null` while it is still open.",
	}),
	last_observed_value: Schema.NullOr(Schema.Number).annotate({
		description: "The most recently observed value, or `null`.",
		examples: [0.09],
	}),
	last_sample_count: Schema.NullOr(Schema.Number).annotate({
		description: "Sample count of the most recent observation, or `null`.",
	}),
	dedupe_key: Schema.String.annotate({
		description:
			"Stable identity of the (rule, group) incident stream, used to deduplicate notifications.",
	}),
	last_delivered_event_type: Schema.NullOr(AlertNotificationEventType).annotate({
		description:
			"The most recent notification event delivered for this incident (`trigger`, `resolve`, `renotify`, `test`), or `null`.",
	}),
	last_notified_at: Schema.NullOr(Timestamp).annotate({
		description: "When a notification was last delivered for this incident, or `null`.",
	}),
	hold_reason: Schema.NullOr(AlertIncidentHoldReason).annotate({
		description:
			"Set while an open incident is waiting on telemetry: the breach stopped appearing, but the service's data could not be proven to still be flowing. `volume_collapsed`, `no_data` and `sampling_changed` resolve once telemetry resumes or their hold ceiling elapses; `probe_failed` (Maple could not run the check) has no ceiling and resolves on the next successful check. `null` while firing or once resolved.",
	}),
	held_since: Schema.NullOr(Timestamp).annotate({
		description: "When the current hold began, or `null` when the incident is not held.",
	}),
	acknowledged_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When someone acknowledged this open incident, or `null`. While acknowledged, reminders (`renotify`) pause; an escalation to a higher severity still notifies and clears the acknowledgement. Cleared when the incident resolves.",
	}),
	acknowledged_by: Schema.NullOr(V2AlertIncidentActor).annotate({
		description: "Who acknowledged the incident, or `null` when it is not acknowledged.",
	}),
	acknowledged_via: Schema.NullOr(AlertIncidentAckSource).annotate({
		description:
			"Where the acknowledgement came from (`web`, `api`, `mcp`, `slack`, `discord`), or `null` when not acknowledged.",
		examples: ["slack"],
	}),
	error_issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The linked error issue (`iss_…`) when the incident was correlated to one, or `null`.",
	}),
	group_label: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description:
				"What to show as the incident's group when `group_key` is not readable, e.g. an anomaly's `checkout (production)`. Absent when the group key is its own label.",
		}),
	),
	anomaly_incident_id: Schema.optionalKey(
		Schema.NullOr(AnomalyIncidentPublicId).annotate({
			description:
				"`anomaly` rules only: the anomaly incident this alert incident pages on. Absent on other rules.",
		}),
	),
	silence_id: Schema.NullOr(AlertSilencePublicId).annotate({
		description:
			"The alert silence (`sil_…`) that last held back one of this incident's notifications, or `null`.",
	}),
	silenced_at: Schema.NullOr(Timestamp).annotate({
		description:
			"Set while a silenced notification is still owed: the first breaching check after the silence ends sends it and clears this. `null` otherwise.",
	}),
}).annotate({
	identifier: "AlertIncident",
	title: "Alert Incident",
	description:
		"A period during which an alert rule's condition held: opened after enough consecutive breaches, resolved by the scheduler after enough consecutive healthy checks. An open incident can be acknowledged to pause reminders; resolution is scheduler-driven.",
	examples: [wireExample(alertIncidentExample)],
})
export type V2AlertIncident = Schema.Schema.Type<typeof V2AlertIncident>

export const V2AlertIncidentEvent = Schema.Struct({
	id: AlertIncidentEventPublicId,
	object: Schema.Literal("alert_incident_event").annotate({
		description: 'The object type — always `"alert_incident_event"`.',
		examples: ["alert_incident_event"],
	}),
	incident_id: AlertIncidentPublicId,
	type: AlertIncidentEventType.annotate({
		description:
			"`acknowledged` or `unacknowledged` by a person, or `ack_cleared` when the scheduler cleared an acknowledgement because the incident escalated to a higher severity.",
		examples: ["acknowledged"],
	}),
	actor: Schema.NullOr(V2AlertIncidentActor).annotate({
		description: "Who did it, or `null` for a scheduler-written event.",
	}),
	source: Schema.NullOr(AlertIncidentAckSource).annotate({
		description: "Where it came from, or `null` for a scheduler-written event.",
	}),
	created_at: Timestamp,
}).annotate({
	identifier: "AlertIncidentEvent",
	title: "Alert Incident Event",
	description: "One entry in an alert incident's activity log, oldest first.",
})
export type V2AlertIncidentEvent = Schema.Schema.Type<typeof V2AlertIncidentEvent>

const AlertIncidentEventList = Schema.Struct({
	object: Schema.Literal("list"),
	data: Schema.Array(V2AlertIncidentEvent),
}).annotate({
	identifier: "AlertIncidentEventList",
	title: "Alert incident event list",
	description: "An incident's activity, oldest first.",
})

const IncidentsQuery = Schema.Struct({
	...ListQuery.fields,
	status: Schema.optional(
		AlertIncidentStatus.annotate({
			description: "Only return incidents with this status (`open` or `resolved`).",
			examples: ["open"],
		}),
	),
	rule_id: Schema.optional(
		AlertRulePublicId.annotate({
			description: "Only return incidents opened by this alert rule (`alrt_…`).",
		}),
	),
	acknowledged: Schema.optional(
		Schema.Literals(["true", "false"]).annotate({
			description:
				"`true` for open incidents someone has acknowledged, `false` for open incidents nobody has. Implies `status=open`.",
			examples: ["false"],
		}),
	),
}).annotate({
	identifier: "AlertIncidentListQuery",
	title: "Alert incident list query",
	description: "Pagination plus optional status / rule filters.",
})

const alertPersistence = publicError(AlertPersistenceError)
const alertIncidentNotFound = publicError(AlertIncidentNotFoundError)
const alertIncidentResolved = publicError(AlertIncidentResolvedError)

const AlertIncidentList = ListOf(V2AlertIncident).annotate({
	identifier: "AlertIncidentList",
	title: "Alert incident list",
	description: "A cursor-paginated page of alert incidents.",
})

export class V2AlertIncidentsApiGroup extends HttpApiGroup.make("alertIncidents")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: IncidentsQuery,
			success: AlertIncidentList,
			error: [V2ParameterInvalid.schema, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertIncidents",
				summary: "List alert incidents",
				description:
					"Returns your organization's alert incidents, most recently triggered first, optionally filtered by `status` or `rule_id`. Cursor-paginated. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AlertIncidentPublicId },
			success: V2AlertIncident,
			error: [alertIncidentNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAlertIncident",
				summary: "Retrieve an alert incident",
				description:
					"Returns a single alert incident by its `inc_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("acknowledge", "/:id/acknowledge", {
			params: { id: AlertIncidentPublicId },
			success: V2AlertIncident,
			error: [alertIncidentNotFound, alertIncidentResolved, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "acknowledgeAlertIncident",
				summary: "Acknowledge an alert incident",
				description:
					"Marks an open incident as acknowledged by the calling user, which pauses reminders until it is unacknowledged, escalates to a higher severity, or resolves. Acknowledging an already acknowledged incident changes nothing and returns it. Fails with 409 on a resolved incident. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("unacknowledge", "/:id/unacknowledge", {
			params: { id: AlertIncidentPublicId },
			success: V2AlertIncident,
			error: [alertIncidentNotFound, alertIncidentResolved, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "unacknowledgeAlertIncident",
				summary: "Unacknowledge an alert incident",
				description:
					"Clears an open incident's acknowledgement, so reminders resume: one that came due while it was acknowledged is sent on the next check. Fails with 409 on a resolved incident. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listEvents", "/:id/events", {
			params: { id: AlertIncidentPublicId },
			success: AlertIncidentEventList,
			error: [alertIncidentNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertIncidentEvents",
				summary: "List an alert incident's events",
				description:
					"Returns the incident's acknowledgement history, oldest first, up to its 500 most recent entries. Requires the `alerts:read` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/incidents")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Incidents",
			description:
				"The incident history produced by your alert rules. Incidents open when a rule breaches for enough consecutive checks and resolve automatically once the signal recovers. An open incident can be acknowledged to pause its reminders.",
		}),
	) {}
