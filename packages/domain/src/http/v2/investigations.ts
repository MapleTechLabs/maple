import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AiTriageIncidentKind } from "../ai-triage"
import { IssueSeverity } from "../errors"
import {
	InvestigationConfidence,
	InvestigationAgentUnavailableError,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationSeededBy,
	InvestigationStartFailedError,
	InvestigationStatus,
} from "../investigations"
import { TraceId, UserId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { encodePublicId, PublicIdPrefixes } from "./public-id"
import { publicErrors } from "./public-error"
import {
	AlertIncidentPublicId,
	AnomalyIncidentPublicId,
	ErrorIncidentPublicId,
	ErrorIssuePublicId,
	InvestigationPublicId,
} from "./resource-ids"

export { ErrorIssuePublicId, InvestigationPublicId } from "./resource-ids"

// Subject (snake_case wire form of the internal InvestigationSubject union)

/** A page/entity context hint (structurally the web's AutoContext) — opaque JSON. */
const InvestigationContextRef = Schema.Record(Schema.String, Schema.Unknown)

const investigationIncidentSubjectBase = {
	type: Schema.Literal("incident").annotate({
		description: 'Discriminator — always `"incident"` for an incident-anchored investigation.',
	}),
}

const investigationIncidentVariants = <IssueId extends Schema.Top>(issueId: IssueId) =>
	Schema.Union([
		Schema.Struct({
			...investigationIncidentSubjectBase,
			issue_id: issueId,
			incident_kind: Schema.Literal("error"),
			incident_id: ErrorIncidentPublicId,
		}),
		Schema.Struct({
			...investigationIncidentSubjectBase,
			issue_id: issueId,
			incident_kind: Schema.Literal("anomaly"),
			incident_id: AnomalyIncidentPublicId,
		}),
		Schema.Struct({
			...investigationIncidentSubjectBase,
			issue_id: issueId,
			incident_kind: Schema.Literal("alert"),
			incident_id: AlertIncidentPublicId,
		}),
	])

export const V2InvestigationIncidentSubject = investigationIncidentVariants(
	Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The linked `iss_…` error issue, or `null` when the incident has none.",
	}),
).annotate({
	identifier: "InvestigationIncidentSubject",
	title: "Incident subject",
	description:
		"An investigation anchored to a typed incident. The public-ID prefix must match `incident_kind`: `einc_…`, `anom_…`, or `inc_…`.",
})

const V2InvestigationIncidentSubjectInput = investigationIncidentVariants(
	Schema.optionalKey(
		ErrorIssuePublicId.annotate({
			description: "The `iss_…` ID of the linked error issue, when the incident is backed by one.",
		}),
	),
)

export const V2InvestigationFreeformSubject = Schema.Struct({
	type: Schema.Literal("freeform").annotate({
		description: 'Discriminator — always `"freeform"` for an ad-hoc investigation.',
	}),
	title: Schema.String.annotate({ description: "Short human-readable title for the investigation." }),
	prompt: Schema.String.annotate({ description: "The question or task the investigation should answer." }),
	context_refs: Schema.Array(InvestigationContextRef).annotate({
		description:
			"Opaque context hints (services, traces, dashboards, …) passed through verbatim for the agent to read as JSON.",
	}),
}).annotate({
	identifier: "InvestigationFreeformSubject",
	title: "Freeform subject",
	description: "An ad-hoc investigation into a user-supplied question with optional context.",
})

/**
 * Read-only on purpose: a fix verification is opened by the verification tick
 * when a linked pull request merges, never by a caller. It is absent from
 * {@link V2InvestigationCreateSubject} for that reason.
 */
export const V2InvestigationFixVerificationSubject = Schema.Struct({
	type: Schema.Literal("fix_verification").annotate({
		description: 'Discriminator — always `"fix_verification"` for a post-merge fix check.',
	}),
	issue_id: ErrorIssuePublicId.annotate({
		description: "The `iss_…` error issue whose fix is being verified.",
	}),
	pull_request_url: Schema.String.annotate({
		description: "The merged pull request the verification is checking.",
	}),
	baseline_versions: Schema.Array(Schema.String).annotate({
		description:
			"Builds the issue was known to affect when the fix merged. An occurrence from a build outside this set means the fix did not work.",
	}),
	merged_at: Schema.String.annotate({ description: "When the pull request merged (ISO 8601)." }),
}).annotate({
	identifier: "InvestigationFixVerificationSubject",
	title: "Fix verification subject",
	description: "An investigation that checks whether a merged pull request actually stopped an error.",
})

export const V2InvestigationSubject = Schema.Union([
	V2InvestigationIncidentSubject,
	V2InvestigationFreeformSubject,
	V2InvestigationFixVerificationSubject,
]).annotate({
	identifier: "InvestigationSubject",
	title: "Investigation subject",
	description: "What is being investigated — a typed incident or an ad-hoc question.",
})
export type V2InvestigationSubject = Schema.Schema.Type<typeof V2InvestigationSubject>

export const V2InvestigationCreateSubject = Schema.Union([
	V2InvestigationIncidentSubjectInput,
	V2InvestigationFreeformSubject,
])
export type V2InvestigationCreateSubject = Schema.Schema.Type<typeof V2InvestigationCreateSubject>

const V2AiTriageEvidence = Schema.Struct({
	traceIds: Schema.Array(TraceId),
	logPatterns: Schema.Array(Schema.String),
	relatedServices: Schema.Array(Schema.String),
	note: Schema.String,
}).pipe(
	Schema.encodeKeys({
		traceIds: "trace_ids",
		logPatterns: "log_patterns",
		relatedServices: "related_services",
	}),
)

/** Snake-case v2 wire projection of the internal AI triage result. */
const V2AiTriageResult = Schema.Struct({
	/**
	 * `optionalKey`, mirroring the internal report: reports stored before the
	 * field existed still decode, and a client falls back to `summary`.
	 */
	headline: Schema.optionalKey(Schema.String).annotate({
		description:
			"One line naming the suspected cause, for list rows and headings. Absent on reports produced before the field existed.",
	}),
	summary: Schema.String,
	suspectedCause: Schema.String,
	/**
	 * `optionalKey`, mirroring the internal report: a partial has no cause to
	 * assess, and reports stored before the field became optional still decode.
	 * A client reading a run's severity wants the investigation's own `severity`,
	 * which is null on a partial by design.
	 */
	severityAssessment: Schema.optionalKey(IssueSeverity),
	affectedScope: Schema.String,
	evidence: Schema.Array(V2AiTriageEvidence),
	suggestedActions: Schema.Array(Schema.String),
	confidence: Schema.Literals(["high", "medium", "low"]),
	/**
	 * What was eliminated, and what could not be looked at.
	 *
	 * `ruled_out` has been stored on every report since it was added and was
	 * never projected onto the wire, so no client has ever been able to see what
	 * a run considered. On an `inconclusive` investigation these two ARE the
	 * result — omitting them would ship a partial with its payload removed.
	 *
	 * `optionalKey` because every report stored before they existed still has to
	 * decode.
	 */
	ruledOut: Schema.optionalKey(Schema.Array(Schema.String)),
	unchecked: Schema.optionalKey(Schema.Array(Schema.String)),
}).pipe(
	Schema.encodeKeys({
		suspectedCause: "suspected_cause",
		severityAssessment: "severity_assessment",
		affectedScope: "affected_scope",
		suggestedActions: "suggested_actions",
		ruledOut: "ruled_out",
	}),
)

/** Snake-case v2 wire projection of a run's step tail. */
const V2InvestigationProgress = Schema.Struct({
	/**
	 * How many steps the run has taken, which `steps.length` does not answer:
	 * `steps` is a capped tail, so a long run reports more steps than it carries.
	 */
	stepCount: Schema.Number,
	steps: Schema.Array(
		Schema.Struct({
			tool: Schema.String,
			label: Schema.String,
			at: Schema.Number,
		}),
	),
	/** Epoch ms of the last step. What a reader checks to see the run is alive. */
	updatedAt: Schema.Number,
}).pipe(Schema.encodeKeys({ stepCount: "step_count", updatedAt: "updated_at" }))

const V2InvestigationSnapshot = Schema.Struct({
	title: Schema.String,
	scope: Schema.NullOr(Schema.String),
	status: Schema.String,
	severity: Schema.NullOr(IssueSeverity),
	facts: Schema.Array(
		Schema.Struct({
			label: Schema.String,
			value: Schema.String,
		}),
	),
	references: Schema.Array(
		Schema.Struct({
			label: Schema.String,
			url: Schema.String,
		}),
	),
	incidentStartedAt: Schema.NullOr(Timestamp),
	incidentEndedAt: Schema.NullOr(Timestamp),

	// The identifiers the agent needs to call tools with, as distinct from the
	// display `facts` above. On the create payload these are what let a caller
	// hand the investigation a fingerprint and an incident window instead of
	// making the agent guess both — `error_detail` cannot be called without the
	// former, and every prompt opens by scoping to the latter. All optional so a
	// caller that has none of them, and every client built before this, still
	// posts a valid snapshot.
	fingerprintHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
	exceptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	exceptionMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
	topFrame: Schema.optionalKey(Schema.NullOr(Schema.String)),
	errorLabel: Schema.optionalKey(Schema.NullOr(Schema.String)),
	occurrenceCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	deploymentEnv: Schema.optionalKey(Schema.NullOr(Schema.String)),
	signalType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	observedValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	thresholdValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}).pipe(
	Schema.encodeKeys({
		incidentStartedAt: "incident_started_at",
		incidentEndedAt: "incident_ended_at",
		fingerprintHash: "fingerprint_hash",
		exceptionType: "exception_type",
		exceptionMessage: "exception_message",
		topFrame: "top_frame",
		errorLabel: "error_label",
		occurrenceCount: "occurrence_count",
		serviceName: "service_name",
		deploymentEnv: "deployment_env",
		signalType: "signal_type",
		observedValue: "observed_value",
		thresholdValue: "threshold_value",
	}),
)

// Resource

const investigationExample = {
	id: "inv_YofPTrK9782DWwcnXhpcCw",
	object: "investigation",
	status: "diagnosed",
	subject: {
		type: "incident",
		incident_kind: "error",
		incident_id: encodePublicId(PublicIdPrefixes.errorIncident, "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8"),
		issue_id: "iss_YofPTrK9782DWwcnXhpcCw",
	},
	snapshot: {
		title: "Checkout timeout rate increased",
		scope: "checkout-api",
		status: "open",
		severity: "high",
		facts: [],
		references: [],
		incident_started_at: "2026-07-15T09:04:00.000Z",
		incident_ended_at: null,
	},
	report: {
		headline: "Deploy 4f21a shortened checkout-api's upstream timeout",
		summary: "A deploy to checkout-api four minutes before the onset regressed the timeout budget.",
		suspected_cause: "Deploy 4f21a shortened the upstream timeout below the p99 of the call it guards.",
		severity_assessment: "high",
		affected_scope: "checkout-api",
		evidence: [],
		suggested_actions: ["Roll back deploy 4f21a."],
		confidence: "high",
		// Present on the example so the existing decode test exercises the two keys
		// a partial result depends on. `ruled_out` in particular has been stored
		// since it was added and was never projected onto the wire.
		ruled_out: ["Downstream dependency: every callee stayed under 90ms in the window."],
		unchecked: [],
	},
	// A diagnosed investigation, so the run is over and the feed is its record of
	// how it got there. A running example would need a wall-clock `updated_at` to
	// make sense, which an OpenAPI example cannot have.
	progress: {
		step_count: 9,
		steps: [
			{ tool: "diagnose_service", label: "Diagnose service · checkout-api", at: 1_763_020_800_000 },
			{ tool: "inspect_trace", label: "Inspect trace · 7f3a9c04b1", at: 1_763_020_812_000 },
		],
		updated_at: 1_763_020_812_000,
	},
	model: "claude-opus-4-8",
	severity: "high",
	confidence: "high",
	seeded_by: "system",
	created_by: null,
	input_tokens: 12000,
	output_tokens: 800,
	error: null,
	created_at: "2026-07-15T09:12:00.000Z",
	started_at: "2026-07-15T09:12:05.000Z",
	diagnosed_at: "2026-07-15T09:12:42.000Z",
	updated_at: "2026-07-15T09:12:42.000Z",
} as const

export const V2Investigation = Schema.Struct({
	id: InvestigationPublicId,
	object: Schema.Literal("investigation").annotate({
		description: 'The object type — always `"investigation"`.',
		examples: ["investigation"],
	}),
	status: InvestigationStatus.annotate({
		description:
			"Lifecycle state: `investigating` (diagnostic pass in progress), `diagnosed` (report attached), `resolved` (human-closed), or `failed`.",
		examples: ["diagnosed"],
	}),
	subject: V2InvestigationSubject,
	snapshot: V2InvestigationSnapshot.annotate({
		description:
			"A display-ready snapshot captured when the investigation was opened, retained even after source telemetry expires.",
	}),
	progress: Schema.NullOr(V2InvestigationProgress).annotate({
		description:
			"What the pass is doing, or got as far as doing, as a capped tail of steps. `null` before the first step. Kept after the run ends.",
	}),
	report: Schema.NullOr(V2AiTriageResult).annotate({
		description:
			"The latest structured AI diagnosis, or `null` until the first diagnosis lands. The report's internal fields are an evolving shape — treat it as a diagnosis blob, not a stability-committed schema.",
	}),
	model: Schema.NullOr(Schema.String).annotate({
		description: "The model that produced the diagnosis, or `null`.",
	}),
	severity: Schema.NullOr(IssueSeverity).annotate({
		description: "Severity denormalized from the report for cheap list rendering, or `null`.",
	}),
	confidence: Schema.NullOr(InvestigationConfidence).annotate({
		description: "The diagnosis confidence (`high`/`medium`/`low`), or `null`.",
	}),
	seeded_by: InvestigationSeededBy.annotate({
		description: "Who opened the investigation: `user` (attended) or `system` (incident-open trigger).",
	}),
	created_by: Schema.NullOr(UserId).annotate({
		description: "The `user_…` ID that opened the investigation, or `null` for system-seeded ones.",
	}),
	input_tokens: Schema.NullOr(Schema.Number).annotate({
		description: "Input tokens consumed by the diagnostic pass, or `null`.",
	}),
	output_tokens: Schema.NullOr(Schema.Number).annotate({
		description: "Output tokens produced by the diagnostic pass, or `null`.",
	}),
	error: Schema.NullOr(Schema.String).annotate({
		description: "The failure message if the diagnostic pass errored, or `null`.",
	}),
	created_at: Timestamp.annotate({ description: "When the investigation was opened." }),
	started_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the current pass began, re-stamped on each restart. Use this rather than `created_at` to measure how long a run took.",
	}),
	diagnosed_at: Schema.NullOr(Timestamp).annotate({
		description: "When a diagnosis was first attached, or `null`.",
	}),
	updated_at: Timestamp.annotate({ description: "When the investigation was last updated." }),
}).annotate({
	identifier: "Investigation",
	title: "Investigation",
	description:
		"A durable investigation 'war-room' — an autonomous or human-opened diagnostic session over an incident or an ad-hoc question. Carries the structured AI diagnosis once it lands.",
	examples: [wireExample(investigationExample)],
})
export type V2Investigation = Schema.Schema.Type<typeof V2Investigation>

// Requests / queries

export const V2InvestigationCreateParams = Schema.Struct({
	subject: V2InvestigationCreateSubject,
	snapshot: Schema.optionalKey(V2InvestigationSnapshot),
}).annotate({
	identifier: "InvestigationCreateParams",
	title: "Investigation create parameters",
	description:
		"Request body for opening an investigation. Incident-anchored investigations dedup to one per incident.",
	examples: [
		wireExample({
			subject: {
				type: "incident",
				incident_kind: "error",
				incident_id: encodePublicId(
					PublicIdPrefixes.errorIncident,
					"018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8",
				),
			},
		}),
	],
})
export type V2InvestigationCreateParams = Schema.Schema.Type<typeof V2InvestigationCreateParams>

export const V2InvestigationStatusUpdateParams = Schema.Struct({
	status: InvestigationStatus.annotate({
		description: "The new lifecycle status.",
		examples: ["resolved"],
	}),
}).annotate({
	identifier: "InvestigationStatusUpdateParams",
	title: "Investigation status update parameters",
	description: "Request body for changing an investigation's lifecycle status.",
	examples: [wireExample({ status: "resolved" })],
})
export type V2InvestigationStatusUpdateParams = Schema.Schema.Type<typeof V2InvestigationStatusUpdateParams>

export const V2InvestigationsListQuery = Schema.Struct({
	...ListQuery.fields,
	status: Schema.optional(
		InvestigationStatus.annotate({ description: "Only return investigations in this status." }),
	),
	issue_id: Schema.optional(
		ErrorIssuePublicId.annotate({
			description: "Only return investigations for this `iss_…` error issue.",
		}),
	),
	incident_kind: Schema.optional(
		AiTriageIncidentKind.annotate({ description: "Only return investigations for this incident kind." }),
	),
	incident_id: Schema.optional(
		Schema.Union([ErrorIncidentPublicId, AnomalyIncidentPublicId, AlertIncidentPublicId]).annotate({
			description: "Only return investigations for this prefixed incident ID.",
		}),
	),
}).annotate({
	identifier: "InvestigationsListQuery",
	title: "Investigations list query",
	description: "Pagination plus optional filters for the investigations list.",
})
export type V2InvestigationsListQuery = Schema.Schema.Type<typeof V2InvestigationsListQuery>

const [
	investigationPersistence,
	investigationNotFound,
	investigationAgentUnavailable,
	investigationStartFailed,
	investigationDataCorruption,
] = publicErrors(
	InvestigationPersistenceError,
	InvestigationNotFoundError,
	InvestigationAgentUnavailableError,
	InvestigationStartFailedError,
	InvestigationDataCorruptionError,
)

const investigationStartErrors = [
	investigationPersistence,
	investigationAgentUnavailable,
	investigationStartFailed,
	investigationDataCorruption,
] as const

const InvestigationList = ListOf(V2Investigation).annotate({
	identifier: "InvestigationList",
	title: "Investigation list",
	description: "A cursor-paginated page of investigations, newest first.",
})

export class V2InvestigationsApiGroup extends HttpApiGroup.make("investigations")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2InvestigationsListQuery,
			success: InvestigationList,
			error: [V2ParameterInvalid.schema, investigationPersistence, investigationDataCorruption],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listInvestigations",
				summary: "List investigations",
				description:
					"Returns your organization's investigations, newest first, optionally filtered by status, error issue, or incident. Cursor-paginated. Requires the `investigations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: InvestigationPublicId },
			success: V2Investigation,
			error: [investigationPersistence, investigationNotFound, investigationDataCorruption],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getInvestigation",
				summary: "Retrieve an investigation",
				description:
					"Returns a single investigation by its `inv_…` ID, including its diagnosis when one exists. Requires the `investigations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2InvestigationCreateParams,
			success: V2Investigation,
			error: investigationStartErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createInvestigation",
				summary: "Open an investigation",
				description:
					"Opens an investigation over an incident or an ad-hoc question. Incident-anchored investigations return the existing war-room if one is already open. Requires the `investigations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("restart", "/:id/restart", {
			params: { id: InvestigationPublicId },
			success: V2Investigation,
			error: [investigationNotFound, ...investigationStartErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "restartInvestigation",
				summary: "Restart an investigation",
				description:
					"Starts a replacement autonomous pass while retaining the previous report until a new diagnosis lands. Requires the `investigations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("updateStatus", "/:id/status", {
			params: { id: InvestigationPublicId },
			payload: V2InvestigationStatusUpdateParams,
			success: V2Investigation,
			error: [investigationPersistence, investigationNotFound, investigationDataCorruption],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateInvestigationStatus",
				summary: "Update investigation status",
				description:
					"Changes an investigation's lifecycle status (e.g. resolve it). Requires the `investigations:write` scope.",
			}),
		),
	)
	.prefix("/v2/investigations")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Investigations",
			description:
				"Durable investigation war-rooms — autonomous or human-opened diagnostic sessions over incidents and ad-hoc questions, each carrying its structured AI diagnosis.",
		}),
	) {}
