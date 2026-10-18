import { Effect, Option, Predicate, Schema } from "effect"
import { ErrorIssueDocument, ErrorIssueNotFoundError, IssueSeverity, WorkflowState } from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import { issueSeed, type SeededIssue } from "../../backend/endpoints/error-issues.ts"
import type { FixtureWarehouse } from "../../backend/warehouse.ts"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { fixtureUuid } from "../identity.ts"

/**
 * The issue workflow writes the errors pages send (transition, claim, heartbeat, release,
 * severity). Nothing is persisted: each answers the seeded row as the server would return it
 * after the write, so the call log carries the request and both apps take the same success path.
 */

const encodeDocument = Schema.encodeUnknownEffect(ErrorIssueDocument)
const decodeDocument = Schema.decodeUnknownEffect(ErrorIssueDocument)
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeState = Schema.decodeUnknownOption(WorkflowState)
const decodeSeverity = Schema.decodeUnknownOption(IssueSeverity)

const field = (value: unknown, key: string): unknown =>
	Predicate.hasProperty(value, key) ? value[key] : undefined
const str = (value: unknown, key: string): string | undefined => {
	const found = field(value, key)
	return typeof found === "string" ? found : undefined
}

const actorOf = (actor: SeededIssue["assigned_actor"]) =>
	actor === null
		? null
		: {
				id: actor.id,
				type: actor.type,
				userId: actor.user_id,
				agentName: actor.agent_name,
				model: actor.model,
				capabilities: actor.capabilities,
				lastActiveAt: actor.last_active_at,
			}

/** The v2 row (snake case) as the internal `ErrorIssueDocument`, with the write's patch applied. */
const documentOf = (issue: SeededIssue, patch: Readonly<Record<string, unknown>>) =>
	decodeDocument({
		id: issue.id,
		kind: issue.kind,
		fingerprintHash: issue.fingerprint_hash,
		serviceName: issue.service_name,
		exceptionType: issue.exception_type,
		exceptionMessage: issue.exception_message,
		errorLabel: issue.error_label,
		topFrame: issue.top_frame,
		workflowState: issue.workflow_state,
		priority: issue.priority,
		severity: issue.severity,
		severitySource: issue.severity_source,
		sourceRef: issue.source_ref,
		assignedActor: actorOf(issue.assigned_actor),
		leaseHolder: actorOf(issue.lease_holder),
		leaseExpiresAt: issue.lease_expires_at,
		claimedAt: issue.claimed_at,
		notes: issue.notes,
		firstSeenAt: issue.first_seen_at,
		lastSeenAt: issue.last_seen_at,
		occurrenceCount: issue.occurrence_count,
		resolvedAt: issue.resolved_at,
		lastResolvedAt: issue.last_resolved_at,
		lastRegressedAt: issue.last_regressed_at,
		regressionCount: issue.regression_count,
		resolvedVersions: issue.resolved_versions,
		snoozeUntil: issue.snooze_until,
		archivedAt: issue.archived_at,
		hasOpenIncident: issue.has_open_incident,
		commentCount: issue.comment_count,
		openPullRequestCount: issue.open_pull_request_count,
		mergedPullRequestCount: issue.merged_pull_request_count,
		...patch,
	}).pipe(Effect.flatMap(encodeDocument))

const writes = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => {
	const issuesOf = issueSeed(warehouse)
	const answer =
		(
			patchOf: (payload: unknown, dataset: Dataset) => Readonly<Record<string, unknown>>,
		): EndpointHandler =>
		({ dataset, params, payload }) =>
			Effect.gen(function* () {
				const id = str(params, "issueId")
				const issue = (yield* issuesOf(dataset)).find((candidate) => candidate.id === id)
				if (issue === undefined)
					return yield* new ErrorIssueNotFoundError({
						message: "Issue not found",
						issueId: decodeIssueId(id ?? fixtureUuid(4, 0)),
					})
				return yield* documentOf(issue, patchOf(payload, dataset))
			})
	return {
		"errors.transitionIssue": answer((payload) =>
			Option.match(decodeState(field(payload, "toState")), {
				onNone: () => ({}),
				onSome: (workflowState) => ({ workflowState }),
			}),
		),
		"errors.claimIssue": answer(() => ({})),
		"errors.heartbeatIssue": answer(() => ({})),
		"errors.releaseIssue": answer(() => ({ leaseHolder: null, leaseExpiresAt: null, claimedAt: null })),
		"errors.setIssueSeverity": answer((payload) => ({
			severity: Option.getOrNull(decodeSeverity(field(payload, "severity"))),
			severitySource: "manual" as const,
		})),
	}
}

export const fixtureArea: FixtureArea = { area: "errors", endpoints: writes }
