import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Option, Predicate, Schema } from "effect"
import { ErrorIssueDocument, ErrorIssueNotFoundError, IssueSeverity, WorkflowState } from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import { issueSeed, type SeededIssue } from "../../backend/endpoints/error-issues.ts"
import type { FixtureWarehouse } from "../../backend/warehouse.ts"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { fixtureUuid } from "../identity.ts"
import { acmeGithubEndpoints } from "../datasets/acme-github.ts"
import { defaultDataset } from "../datasets/default.ts"

/**
 * The issue workflow writes the errors pages send (transition, claim, heartbeat, release,
 * severity). Nothing is persisted: each answers the seeded row as the server would return it
 * after the write, so the call log carries the request and both apps take the same success path.
 */

const encodeDocument = Schema.encodeUnknownEffect(ErrorIssueDocument)
const decodeDocument = Schema.decodeUnknownEffect(ErrorIssueDocument)
const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeTransition = Schema.decodeUnknownOption(Schema.Struct({ toState: WorkflowState }))
const decodeSeverity = Schema.decodeUnknownOption(Schema.Struct({ severity: IssueSeverity }))

const str = (value: unknown, key: string): string | undefined => {
	if (!Predicate.hasProperty(value, key)) return undefined
	const found = value[key]
	return typeof found === "string" ? found : undefined
}

type EndpointRequest = Parameters<EndpointHandler>[0]

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
			patchOf: (request: EndpointRequest) => Readonly<Record<string, unknown>>,
		): EndpointHandler =>
		(request) =>
			Effect.gen(function* () {
				const id = str(request.params, "issueId")
				const issue = (yield* issuesOf(request.dataset)).find((candidate) => candidate.id === id)
				if (issue === undefined)
					return yield* new ErrorIssueNotFoundError({
						message: "Issue not found",
						issueId: decodeIssueId(id ?? fixtureUuid(4, 0)),
					})
				return yield* documentOf(issue, patchOf(request))
			})
	return {
		"errors.transitionIssue": answer(({ payload }) =>
			Option.match(decodeTransition(payload), {
				onNone: () => ({}),
				onSome: ({ toState }) => ({ workflowState: toState }),
			}),
		),
		"errors.claimIssue": answer(() => ({})),
		"errors.heartbeatIssue": answer(() => ({})),
		"errors.releaseIssue": answer(() => ({ leaseHolder: null, leaseExpiresAt: null, claimedAt: null })),
		"errors.setIssueSeverity": answer(({ payload }) => ({
			severity: Option.getOrNull(Option.map(decodeSeverity(payload), ({ severity }) => severity)),
			severitySource: "manual" as const,
		})),
	}
}

/** The in-progress issue (`fixtureUuid(4, 2)`): a fix under way, so it has history to show. */
const WORKED_ISSUE = fixtureUuid(4, 2)
const nowMsOf = (dataset: Dataset) => parseWarehouseDateTime(dataset.now)
const isoAgo = (dataset: Dataset, ms: number) => new Date(nowMsOf(dataset) - ms).toISOString()
const HOUR_MS = 3_600_000

const pullRequestsOf = (dataset: Dataset) => [
	{
		id: fixtureUuid(0x41, 1),
		issueId: WORKED_ISSUE,
		provider: "github",
		repoFullName: "acme/storefront",
		number: 482,
		url: "https://github.com/acme/storefront/pull/482",
		title: "Retry upstream calls with jittered backoff",
		authorLogin: "ada",
		state: "merged",
		mergedAt: isoAgo(dataset, 2 * HOUR_MS),
		mergeCommitSha: "9f2c1e7",
		linkSource: "auto",
		linkedByActor: null,
		createdAt: isoAgo(dataset, 5 * HOUR_MS),
	},
	{
		id: fixtureUuid(0x41, 2),
		issueId: WORKED_ISSUE,
		provider: "github",
		repoFullName: "acme/storefront",
		number: 491,
		url: "https://github.com/acme/storefront/pull/491",
		title: null,
		authorLogin: null,
		state: "open",
		mergedAt: null,
		mergeCommitSha: null,
		linkSource: "user",
		linkedByActor: null,
		createdAt: isoAgo(dataset, HOUR_MS),
	},
]

const verificationsOf = (dataset: Dataset) => [
	{
		id: fixtureUuid(0x42, 1),
		issueId: WORKED_ISSUE,
		pullRequestId: fixtureUuid(0x41, 1),
		status: "waiting",
		mergedAt: isoAgo(dataset, 2 * HOUR_MS),
		verifyAfter: new Date(nowMsOf(dataset) + 6 * HOUR_MS).toISOString(),
		baselineVersions: ["3.4.2"],
		baselineOccurrenceCount: 42,
		baselineRatePerHour: 3.5,
		postMergeOccurrenceCount: 0,
		investigationId: null,
		verdict: null,
		verdictNote: null,
		attempt: 0,
		createdAt: isoAgo(dataset, 2 * HOUR_MS),
		updatedAt: isoAgo(dataset, 2 * HOUR_MS),
	},
]

const ADA = (dataset: Dataset) => ({
	id: fixtureUuid(7, 1),
	type: "user",
	userId: dataset.identity?.userId ?? "user_parity_ada",
	agentName: null,
	model: null,
	capabilities: [],
	lastActiveAt: null,
})
const TRIAGE_AGENT = {
	id: fixtureUuid(7, 2),
	type: "agent",
	userId: null,
	agentName: "triage-agent",
	model: "claude-sonnet",
	capabilities: [],
	lastActiveAt: null,
}

/** The worked issue's history, oldest first: triage, the claim, the fix, and its verification. */
const eventsOf = (dataset: Dataset) => {
	const event = (
		index: number,
		ago: number,
		type: string,
		actor: unknown,
		payload: Readonly<Record<string, unknown>>,
		states: readonly [string, string] | null = null,
	) => ({
		id: fixtureUuid(0x43, index),
		issueId: WORKED_ISSUE,
		actor,
		type,
		fromState: states?.[0] ?? null,
		toState: states?.[1] ?? null,
		payload,
		createdAt: isoAgo(dataset, ago),
	})
	return [
		event(1, 9 * HOUR_MS, "created", null, {}),
		event(2, 8 * HOUR_MS, "ai_triage", TRIAGE_AGENT, {
			summary:
				"Upstream timeouts from the inventory service.\n\nRetries without backoff amplify the load.",
		}),
		event(3, 8 * HOUR_MS - 60_000, "severity_change", TRIAGE_AGENT, {
			from: "medium",
			to: "high",
			source: "ai",
			confidence: "high",
		}),
		event(4, 6 * HOUR_MS, "claim", ADA(dataset), {}),
		event(5, 6 * HOUR_MS - 60_000, "state_change", ADA(dataset), {}, ["triage", "in_progress"]),
		event(6, 5 * HOUR_MS, "comment", ADA(dataset), { body: "Adding jittered backoff to the client." }),
		event(7, 5 * HOUR_MS - 60_000, "comment", ADA(dataset), { body: "PR incoming." }),
		event(8, 5 * HOUR_MS - 120_000, "pr_linked", null, {
			repoFullName: "acme/storefront",
			number: 482,
			source: "auto",
		}),
		event(9, 2 * HOUR_MS, "pr_merged", null, { repoFullName: "acme/storefront", number: 482 }),
		event(10, 2 * HOUR_MS - 60_000, "verification_started", null, {
			windowMs: 8 * HOUR_MS,
			ratePerHour: 3.5,
		}),
		...(dataset.name === ERRORS_BUSY_DATASET
			? Array.from({ length: BUSY_COMMENTS }, (_, offset) =>
					event(100 + offset, 4 * HOUR_MS - offset * 60_000, "comment", ADA(dataset), {
						body: `Load test run ${offset + 1}: p99 still above the budget.`,
					}),
				)
			: []),
	]
}

const escalationsOf = (dataset: Dataset) => [
	{
		id: fixtureUuid(0x44, 1),
		issueId: WORKED_ISSUE,
		investigationId: null,
		severity: "high",
		source: "ai",
		reason: "severity_escalated",
		status: "sent",
		attempts: 1,
		skipReason: null,
		deliveries: [
			{
				destinationId: fixtureUuid(0x45, 1),
				destinationName: "On-call webhook",
				status: "delivered",
				error: null,
			},
		],
		createdAt: isoAgo(dataset, 8 * HOUR_MS - 120_000),
		processedAt: isoAgo(dataset, 8 * HOUR_MS - 120_000),
	},
]

const forWorked =
	<A>(worked: (dataset: Dataset) => A, otherwise: A): EndpointHandler =>
	({ dataset, params }) =>
		Effect.succeed(str(params, "issueId") === WORKED_ISSUE ? worked(dataset) : otherwise)

/** Reads of the worked issue's history; every other issue keeps the empty defaults. */
const reads = {
	"errors.listIssuePullRequests": forWorked(
		(dataset) => ({ pullRequests: pullRequestsOf(dataset), suggestedRepository: null }),
		{ pullRequests: [], suggestedRepository: null },
	),
	"errors.listIssueVerifications": forWorked((dataset) => ({ verifications: verificationsOf(dataset) }), {
		verifications: [],
	}),
	"errors.listIssueEvents": forWorked((dataset) => ({ events: eventsOf(dataset) }), { events: [] }),
	"errors.listIssueEscalations": forWorked((dataset) => ({ attempts: escalationsOf(dataset) }), {
		attempts: [],
	}),
	"errors.commentOnIssue": ({ dataset, params, payload }) =>
		Effect.succeed({
			id: fixtureUuid(0x43, 99),
			issueId: str(params, "issueId") ?? WORKED_ISSUE,
			actor: ADA(dataset),
			type: "comment",
			fromState: null,
			toState: null,
			payload: { body: str(payload, "body") ?? "" },
			createdAt: dataset.now,
		}),
	// Nothing is persisted: a link answers as the open pull request, an unlink with the list.
	"errors.linkIssuePullRequest": ({ dataset }) => Effect.succeed(pullRequestsOf(dataset)[1]),
	"errors.unlinkIssuePullRequest": ({ dataset, params }) =>
		Effect.succeed({
			pullRequests: pullRequestsOf(dataset).filter((pr) => pr.id !== str(params, "pullRequestId")),
			suggestedRepository: null,
		}),
} satisfies Readonly<Record<string, EndpointHandler>>

/**
 * `default` with a busy worked issue (past the timeline's 50 recent rows, so "Show earlier"
 * shows) and a GitHub App on two repositories (the attach dialog's repository select).
 */
export const ERRORS_BUSY_DATASET = "errors-busy"
const BUSY_COMMENTS = 56

const twoRepositories: EndpointHandler = (request) =>
	Effect.map(acmeGithubEndpoints["integrations.githubStatus"](request), (status) => ({
		...status,
		repositories: [
			...status.repositories,
			...status.repositories.map((repo) => ({
				...repo,
				id: fixtureUuid(5, 2),
				fullName: "acme-shop/storefront",
				htmlUrl: "https://github.com/acme-shop/storefront",
			})),
		],
	}))

const errorsBusy: Dataset = {
	...defaultDataset,
	name: ERRORS_BUSY_DATASET,
	endpoints: { ...defaultDataset.endpoints, "integrations.githubStatus": twoRepositories },
}

export const fixtureArea: FixtureArea = {
	area: "errors",
	endpoints: (warehouse) => ({ ...writes(warehouse), ...reads }),
	datasets: [errorsBusy],
}
