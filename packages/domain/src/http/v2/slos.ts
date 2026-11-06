import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { SloId, SloLatencyThresholdMs, SloWindowDays } from "../../primitives"
import { SLO_BURN_WINDOWS_MINUTES, SloTargetPercent, type SloSli } from "../../slo"
import { SloNotFoundError, SloPersistenceError, SloValidationError } from "../slos"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { V2WarehouseReadErrors } from "./query-errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { AlertRulePublicId } from "./resource-ids"

/** `slo_…` public ID ⇄ internal `SloId` (raw UUID). */
export const SloPublicId = PublicId(PublicIdPrefixes.slo, SloId)

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())

export const V2SloSli = Schema.Union([
	Schema.Struct({ type: Schema.Literal("availability") }).annotate({
		title: "Availability SLI",
		description: "Good events are entry-point spans whose status is not `Error`.",
	}),
	Schema.Struct({
		type: Schema.Literal("latency"),
		threshold_ms: SloLatencyThresholdMs.annotate({
			description: "Good events are entry-point spans faster than this many milliseconds.",
			examples: [500],
		}),
	}).annotate({ title: "Latency SLI" }),
]).annotate({
	identifier: "SloSli",
	title: "SLO indicator",
	description: "What counts as a good event among the service's entry-point spans.",
})
export type V2SloSli = Schema.Schema.Type<typeof V2SloSli>

export const sloSliFromWire = (sli: V2SloSli): SloSli =>
	sli.type === "availability"
		? { _tag: "availability" }
		: { _tag: "latency", thresholdMs: sli.threshold_ms }

export const sloSliToWire = (sli: SloSli): V2SloSli =>
	sli._tag === "availability"
		? { type: "availability" }
		: { type: "latency", threshold_ms: sli.thresholdMs }

const nameField = NonEmptyString.annotate({
	description: "Human-readable label.",
	examples: ["Checkout API"],
})
const descriptionField = Schema.NullOr(Schema.String).annotate({
	description: "What the objective promises, for the people reading it.",
})
const serviceNameField = NonEmptyString.annotate({
	description: "The service whose entry-point spans (server, consumer and root spans) are counted.",
	examples: ["checkout"],
})
const environmentsField = Schema.Array(NonEmptyString).annotate({
	description: "Deployment environments counted. Empty counts every environment.",
	examples: [["production"]],
})
const targetField = SloTargetPercent.annotate({
	description: "Target share of good events, in percent (50 to 99.999). 99.9 leaves a 0.1% error budget.",
	examples: [99.9],
})
const windowField = SloWindowDays.annotate({
	description: "Rolling window the error budget is measured over: 7, 28 or 30 days.",
	examples: [30],
})

const sloExample = {
	id: "slo_YofPTrK9782DWwcnXhpcCw",
	object: "slo",
	name: "Checkout API",
	description: null,
	service_name: "checkout",
	environments: ["production"],
	sli: { type: "availability" },
	target_percent: 99.9,
	window_days: 30,
	alert_rule_id: null,
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

export const V2Slo = Schema.Struct({
	id: SloPublicId,
	object: Schema.Literal("slo").annotate({
		description: 'The object type, always `"slo"`.',
		examples: ["slo"],
	}),
	name: nameField,
	description: descriptionField,
	service_name: serviceNameField,
	environments: environmentsField,
	sli: V2SloSli,
	target_percent: targetField,
	window_days: windowField,
	alert_rule_id: Schema.NullOr(AlertRulePublicId).annotate({
		description: "The burn-rate alert rule backing this SLO: its incidents carry this rule id.",
	}),
	created_at: Timestamp.annotate({ description: "When the SLO was created." }),
	updated_at: Timestamp.annotate({ description: "When the SLO was last updated." }),
}).annotate({
	identifier: "Slo",
	title: "SLO",
	description:
		"A service level objective: the share of a service's entry-point spans that must be good over a rolling window.",
	examples: [wireExample(sloExample)],
})
export type V2Slo = Schema.Schema.Type<typeof V2Slo>

export const V2SloCreateParams = Schema.Struct({
	name: nameField,
	description: Schema.optionalKey(descriptionField),
	service_name: serviceNameField,
	environments: Schema.optionalKey(environmentsField),
	sli: V2SloSli,
	target_percent: targetField,
	window_days: Schema.optionalKey(windowField.annotate({ description: "Defaults to 30." })),
}).annotate({
	identifier: "SloCreateParams",
	title: "SLO create parameters",
	description: "Request body for creating an SLO.",
	examples: [
		wireExample({
			name: "Checkout API",
			service_name: "checkout",
			environments: ["production"],
			sli: { type: "availability" },
			target_percent: 99.9,
		}),
	],
})
export type V2SloCreateParams = Schema.Schema.Type<typeof V2SloCreateParams>

export const V2SloUpdateParams = Schema.Struct({
	name: Schema.optionalKey(nameField),
	description: Schema.optionalKey(descriptionField),
	service_name: Schema.optionalKey(serviceNameField),
	environments: Schema.optionalKey(environmentsField),
	sli: Schema.optionalKey(V2SloSli),
	target_percent: Schema.optionalKey(targetField),
	window_days: Schema.optionalKey(windowField),
}).annotate({
	identifier: "SloUpdateParams",
	title: "SLO update parameters",
	description: "Request body for updating an SLO. Omitted fields are left unchanged.",
	examples: [wireExample({ target_percent: 99.95 })],
})
export type V2SloUpdateParams = Schema.Schema.Type<typeof V2SloUpdateParams>

export const V2SloDeleteResponse = Schema.Struct({
	id: SloPublicId,
	object: Schema.Literal("slo"),
	deleted: Schema.Literal(true).annotate({ description: "Always `true`: the SLO no longer exists." }),
}).annotate({
	identifier: "SloDeleteResponse",
	title: "SLO delete response",
	description: "Confirmation that an SLO was deleted.",
	examples: [wireExample({ id: "slo_YofPTrK9782DWwcnXhpcCw", object: "slo", deleted: true })],
})
export type V2SloDeleteResponse = Schema.Schema.Type<typeof V2SloDeleteResponse>

const ratioField = (description: string) => Schema.Number.annotate({ description })

export const V2SloBurnWindow = Schema.Struct({
	window_minutes: Schema.Literals(SLO_BURN_WINDOWS_MINUTES).annotate({
		description: "The window's length in minutes, ending at `as_of`.",
	}),
	burn_rate: ratioField(
		"How fast the window spends the error budget: 1 spends exactly the budget over the SLO window.",
	),
	total_events: ratioField("Sampling-weighted entry-point spans in the window."),
	good_events: ratioField("The good ones among them."),
}).annotate({ identifier: "SloBurnWindow", title: "SLO burn window" })

export const V2SloStatus = Schema.Struct({
	object: Schema.Literal("slo.status"),
	slo_id: SloPublicId,
	as_of: Timestamp.annotate({ description: "When the status was read, to the minute." }),
	total_events: ratioField("Sampling-weighted entry-point spans over the SLO window."),
	good_events: ratioField("The good ones among them."),
	sli: Schema.NullOr(Schema.Number).annotate({
		description: "Share of good events over the SLO window (0 to 1), `null` when there were none.",
	}),
	budget_remaining: ratioField(
		"Share of the window's error budget left: 1 untouched, 0 spent, negative when overspent.",
	),
	burn_windows: Schema.Array(V2SloBurnWindow).annotate({
		description: "The windows the burn-rate alert reads: 5 minutes, 30 minutes, 1 hour and 6 hours.",
	}),
}).annotate({
	identifier: "SloStatus",
	title: "SLO status",
	description: "Where an SLO stands now: its SLI, the budget left and how fast it burns.",
})
export type V2SloStatus = Schema.Schema.Type<typeof V2SloStatus>

export const V2SloStatusList = Schema.Struct({
	object: Schema.Literal("slo.status_list"),
	data: Schema.Array(V2SloStatus).annotate({ description: "One status per SLO, in list order." }),
}).annotate({
	identifier: "SloStatusList",
	title: "SLO status list",
	description: "Every SLO's status at once, read together rather than one request per SLO.",
})
export type V2SloStatusList = Schema.Schema.Type<typeof V2SloStatusList>

export const V2SloHistoryPoint = Schema.Struct({
	at: Timestamp,
	sli: Schema.NullOr(Schema.Number).annotate({
		description: "Share of good events in the bucket ending here, `null` when there were none.",
	}),
	budget_remaining: ratioField("Budget left over the SLO window ending here."),
	burn_rate: ratioField("Burn rate of the bucket ending here."),
}).annotate({ identifier: "SloHistoryPoint", title: "SLO history point" })

export const V2SloHistory = Schema.Struct({
	object: Schema.Literal("slo.history"),
	slo_id: SloPublicId,
	as_of: Timestamp,
	bucket_seconds: Schema.Number.annotate({ description: "Width of each point's bucket." }),
	points: Schema.Array(V2SloHistoryPoint).annotate({ description: "Oldest first, over the SLO window." }),
}).annotate({
	identifier: "SloHistory",
	title: "SLO history",
	description: "The error budget over the SLO window, one point per hour.",
})
export type V2SloHistory = Schema.Schema.Type<typeof V2SloHistory>

const [sloNotFound, sloValidation, sloPersistence] = publicErrors(
	SloNotFoundError,
	SloValidationError,
	SloPersistenceError,
)

const SloList = ListOf(V2Slo).annotate({
	identifier: "SloList",
	title: "SLO list",
	description: "A cursor-paginated page of SLOs.",
})

export class V2SlosApiGroup extends HttpApiGroup.make("slos")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: SloList,
			error: [V2ParameterInvalid.schema, sloPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listSlos",
				summary: "List SLOs",
				description:
					"Returns your organization's SLOs, most recently created first. Cursor-paginated.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("statuses", "/statuses", {
			success: V2SloStatusList,
			error: [sloPersistence, ...V2WarehouseReadErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listSloStatuses",
				summary: "List every SLO's status",
				description:
					"Returns the SLI, budget left and burn windows of every SLO in the organization, read together.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2SloCreateParams,
			success: V2Slo,
			error: [V2InsufficientPermissions.schema, sloValidation, sloPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createSlo",
				summary: "Create an SLO",
				description: "Creates an SLO. Requires a caller who can manage alerts.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: SloPublicId },
			success: V2Slo,
			error: [sloNotFound, sloPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSlo",
				summary: "Retrieve an SLO",
				description: "Returns a single SLO by its `slo_…` ID.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: SloPublicId },
			payload: V2SloUpdateParams,
			success: V2Slo,
			error: [V2InsufficientPermissions.schema, sloNotFound, sloValidation, sloPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateSlo",
				summary: "Update an SLO",
				description:
					"Updates an SLO; omitted fields are unchanged. Requires a caller who can manage alerts.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: SloPublicId },
			success: V2SloDeleteResponse,
			error: [V2InsufficientPermissions.schema, sloNotFound, sloPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteSlo",
				summary: "Delete an SLO",
				description:
					"Permanently deletes an SLO and its burn-rate alert rule. Requires a caller who can manage alerts.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("status", "/:id/status", {
			params: { id: SloPublicId },
			success: V2SloStatus,
			error: [sloNotFound, sloPersistence, ...V2WarehouseReadErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSloStatus",
				summary: "Retrieve an SLO's status",
				description:
					"Returns the SLO's SLI and error budget over its window, and its current burn rates.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("history", "/:id/history", {
			params: { id: SloPublicId },
			success: V2SloHistory,
			error: [sloNotFound, sloPersistence, ...V2WarehouseReadErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSloHistory",
				summary: "Retrieve an SLO's budget history",
				description: "Returns the error budget left over the SLO window, one point per hour.",
			}),
		),
	)
	.prefix("/v2/slos")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "SLOs",
			description:
				"Service level objectives over a service's entry-point spans, with an error budget measured over a rolling window.",
		}),
	) {}
