import { HttpApiBuilder } from "effect/http-api"
import type {
	ActorDocument,
	ErrorIncidentDocument,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	IssueListCursorFields,
	IssueSeverityListCursorFields,
} from "@maple/domain/http"
import { CurrentTenant, IssueListCursor, IssueSeverityListCursor } from "@maple/domain/http"
import type {
	V2ErrorIncident,
	V2ErrorIssue,
	V2ErrorIssueActor,
	V2ErrorIssueDetail,
} from "@maple/domain/http/v2"
import {
	MapleApiV2,
	V2CursorInvalid,
	V2CursorSortMismatch,
	V2ErrorIssueLeaseConflict,
	V2ErrorIssueTransitionConflict,
	V2ParameterInvalid,
} from "@maple/domain/http/v2"
import type {
	ErrorIssueLeaseConflictError,
	ErrorIssueTransitionError,
	ErrorValidationError,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"

const toV2Actor = (actor: ActorDocument): V2ErrorIssueActor => ({
	id: actor.id,
	type: actor.type,
	user_id: actor.userId,
	agent_name: actor.agentName,
	model: actor.model,
	capabilities: actor.capabilities,
	last_active_at: actor.lastActiveAt,
})

export const toV2Issue = (issue: ErrorIssueDocument): V2ErrorIssue => ({
	id: issue.id,
	object: "error_issue",
	kind: issue.kind,
	fingerprint_hash: issue.fingerprintHash,
	service_name: issue.serviceName,
	exception_type: issue.exceptionType,
	exception_message: issue.exceptionMessage,
	error_label: issue.errorLabel,
	top_frame: issue.topFrame,
	workflow_state: issue.workflowState,
	priority: issue.priority,
	severity: issue.severity,
	severity_source: issue.severitySource,
	source_ref: issue.sourceRef,
	assigned_actor: issue.assignedActor === null ? null : toV2Actor(issue.assignedActor),
	lease_holder: issue.leaseHolder === null ? null : toV2Actor(issue.leaseHolder),
	lease_expires_at: issue.leaseExpiresAt,
	claimed_at: issue.claimedAt,
	notes: issue.notes,
	first_seen_at: issue.firstSeenAt,
	last_seen_at: issue.lastSeenAt,
	occurrence_count: issue.occurrenceCount,
	resolved_at: issue.resolvedAt,
	last_resolved_at: issue.lastResolvedAt,
	last_regressed_at: issue.lastRegressedAt,
	regression_count: issue.regressionCount,
	resolved_versions: issue.resolvedVersions,
	snooze_until: issue.snoozeUntil,
	archived_at: issue.archivedAt,
	has_open_incident: issue.hasOpenIncident,
	comment_count: issue.commentCount,
	open_pull_request_count: issue.openPullRequestCount,
	merged_pull_request_count: issue.mergedPullRequestCount,
})

const toV2Incident = (incident: ErrorIncidentDocument): V2ErrorIncident => ({
	id: incident.id,
	object: "error_incident",
	issue_id: incident.issueId,
	status: incident.status,
	reason: incident.reason,
	first_triggered_at: incident.firstTriggeredAt,
	last_triggered_at: incident.lastTriggeredAt,
	resolved_at: incident.resolvedAt,
	occurrence_count: incident.occurrenceCount,
})

export const toV2IssueDetail = (detail: ErrorIssueDetailResponse): V2ErrorIssueDetail => ({
	...toV2Issue(detail.issue),
	timeseries: detail.timeseries.map((point) => ({
		bucket: point.bucket,
		count: point.count,
	})),
	sample_traces: detail.sampleTraces.map((trace) => ({
		trace_id: trace.traceId,
		span_id: trace.spanId,
		service_name: trace.serviceName,
		timestamp: trace.timestamp,
		exception_message: trace.exceptionMessage,
		duration_micros: trace.durationMicros,
	})),
	incidents: detail.incidents.map(toV2Incident),
	environments: detail.environments.map((env) => ({ name: env.name, count: env.count })),
})

const decodeCursor = (
	cursor: string | undefined,
	sort: "last_seen" | "severity",
): Effect.Effect<
	IssueListCursorFields | IssueSeverityListCursorFields | undefined,
	ReturnType<typeof V2CursorInvalid.make> | ReturnType<typeof V2CursorSortMismatch.make>
> => {
	if (cursor === undefined) return Effect.succeed(undefined)
	if (sort === "severity") {
		if (!cursor.startsWith("sev_")) {
			return Effect.fail(V2CursorSortMismatch.make(undefined, { param: "cursor" }))
		}
		return Schema.decodeEffect(IssueSeverityListCursor)(cursor.slice(4)).pipe(
			Effect.mapError(() => V2CursorInvalid.make(undefined, { param: "cursor" })),
		)
	}
	if (cursor.startsWith("sev_")) {
		return Effect.fail(V2CursorSortMismatch.make(undefined, { param: "cursor" }))
	}
	return Schema.decodeEffect(IssueListCursor)(cursor).pipe(
		Effect.mapError(() => V2CursorInvalid.make(undefined, { param: "cursor" })),
	)
}

/**
 * `fingerprint_hash=1,2,3` -> `["1","2","3"]`, or `undefined` when the caller
 * did not filter. A param that is present but yields nothing stays an empty
 * array so it matches no issues, rather than silently widening to everything.
 */
function parseFingerprintHashes(raw: string | undefined): ReadonlyArray<string> | undefined {
	if (raw === undefined) return undefined
	return raw
		.split(",")
		.map((hash) => hash.trim())
		.filter((hash) => hash.length > 0)
}

/** Workflow conflicts keep their domain message but take the v2 envelope. */
const transitionConflict = (error: ErrorIssueTransitionError) =>
	Effect.fail(V2ErrorIssueTransitionConflict.make(error.message))
const leaseConflict = (error: ErrorIssueLeaseConflictError) =>
	Effect.fail(V2ErrorIssueLeaseConflict.make(error.message))
const validationFailed = (error: ErrorValidationError) =>
	Effect.fail(V2ParameterInvalid.make([error.message, ...error.details].join(" ")))

export const HttpV2ErrorIssuesLive = HttpApiBuilder.group(MapleApiV2, "errorIssues", (handlers) =>
	Effect.gen(function* () {
		const readModels = yield* ErrorIssueReadModelsService
		const errors = yield* ErrorsService
		const workflow = yield* ErrorIssueWorkflowService
		const actors = yield* ErrorActorsService

		// Actions run as the signed-in user's actor, the same one the dashboard uses.
		const callerActor = Effect.gen(function* () {
			const tenant = yield* CurrentTenant.Context
			const actor = yield* actors.ensureUserActor(tenant.orgId, tenant.userId)
			return { orgId: tenant.orgId, actorId: actor.id }
		})

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const sort = query.sort ?? "last_seen"
					const cursor = yield* decodeCursor(query.cursor, sort)
					const response = yield* readModels.listIssues(tenant.orgId, {
						workflowState: query.workflow_state,
						severity: query.severity,
						kind: query.kind,
						service: query.service_name,
						fingerprintHashes: parseFingerprintHashes(query.fingerprint_hash),
						deploymentEnv: query.deployment_environment,
						startTime: query.start_time,
						endTime: query.end_time,
						introducedAfter: query.introduced_after,
						actionable: query.actionable === "true",
						stateGroup: query.state,
						search: query.search?.trim() || undefined,
						includeArchived: query.include_archived === "true",
						sort,
						limit: query.limit ?? 20,
						cursor,
					})

					return {
						object: "list" as const,
						data: response.issues.map(toV2Issue),
						has_more: response.nextCursor !== undefined,
						next_cursor: response.nextCursor ?? null,
					}
				}),
			)
			.handle("serviceCounts", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const counts = yield* readModels.countOpenIssuesByService(tenant.orgId)

					return {
						object: "list" as const,
						data: counts.map((row) => ({
							service_name: row.serviceName,
							open_count: row.openCount,
						})),
						has_more: false,
						next_cursor: null,
					}
				}),
			)
			.handle("retrieve", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const detail = yield* readModels.getIssue(tenant.orgId, params.id, {
						startTime: query.start_time,
						endTime: query.end_time,
						bucketSeconds: query.bucket_seconds,
						sampleLimit: query.sample_limit,
					})

					return toV2IssueDetail(detail)
				}),
			)
			.handle("transition", ({ params, payload }) =>
				Effect.gen(function* () {
					const { orgId, actorId } = yield* callerActor
					const issue = yield* errors.transitionIssue(orgId, actorId, params.id, payload.to_state, {
						...(payload.note === undefined ? undefined : { note: payload.note }),
						...(payload.snooze_until === undefined
							? undefined
							: { snoozeUntil: payload.snooze_until }),
					})
					return toV2Issue(issue)
				}).pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueTransitionError": transitionConflict,
						"@maple/http/errors/ErrorValidationError": validationFailed,
					}),
					Effect.withSpan("HttpV2ErrorIssues.transition"),
				),
			)
			.handle("claim", ({ params, payload }) =>
				Effect.gen(function* () {
					const { orgId, actorId } = yield* callerActor
					const leaseMs =
						payload.lease_duration_seconds === undefined
							? undefined
							: payload.lease_duration_seconds * 1000
					const issue = yield* errors.claimIssue(orgId, actorId, params.id, leaseMs)
					return toV2Issue(issue)
				}).pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueTransitionError": transitionConflict,
						"@maple/http/errors/ErrorIssueLeaseConflictError": leaseConflict,
					}),
					Effect.withSpan("HttpV2ErrorIssues.claim"),
				),
			)
			.handle("release", ({ params, payload }) =>
				Effect.gen(function* () {
					const { orgId, actorId } = yield* callerActor
					const issue = yield* workflow.releaseIssue(orgId, actorId, params.id, {
						...(payload.transition_to === undefined
							? undefined
							: { transitionTo: payload.transition_to }),
						...(payload.note === undefined ? undefined : { note: payload.note }),
					})
					return toV2Issue(issue)
				}).pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorIssueTransitionError": transitionConflict,
						"@maple/http/errors/ErrorIssueLeaseConflictError": leaseConflict,
					}),
					Effect.withSpan("HttpV2ErrorIssues.release"),
				),
			)
			.handle("setSeverity", ({ params, payload }) =>
				Effect.gen(function* () {
					const { orgId, actorId } = yield* callerActor
					const issue = yield* workflow.setSeverity(
						orgId,
						actorId,
						params.id,
						payload.severity ?? null,
						{
							...(payload.note === undefined ? undefined : { note: payload.note }),
							source: "manual",
						},
					)
					return toV2Issue(issue)
				}).pipe(Effect.withSpan("HttpV2ErrorIssues.setSeverity")),
			)
	}),
)
