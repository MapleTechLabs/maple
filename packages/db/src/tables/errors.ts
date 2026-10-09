import * as PG from "@maple-dev/effect-orm/postgres"
import {
	ActorType,
	AlertDeliveryStatus,
	AlertSeverity,
	ErrorIncidentReason,
	ErrorIncidentStatus,
	ErrorIssueEventType,
	IssueKind,
	IssueSeverity,
	IssueSeveritySource,
	PullRequestLinkSource,
	PullRequestLinkState,
	VcsProviderId,
	VerificationStatus,
	VerificationVerdict,
	WorkflowState,
} from "@maple/domain/http"
import {
	ActorId,
	AlertDestinationId,
	ErrorIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	ErrorIssuePullRequestId,
	ErrorIssueVerificationId,
	InvestigationId,
	OrgId,
	UserId,
} from "@maple/domain/primitives"
import { Schema } from "effect"

const StringList = Schema.Array(Schema.String)

/**
 * Actors are the subjects of every mutation on the issue system: humans and
 * LLM agents alike. A human's actor row is lazily created the first time they
 * interact with an issue; agents are registered explicitly.
 */
export const Actors = PG.table("actors", {
	columns: {
		id: PG.brand(PG.text, ActorId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		type: PG.brand(PG.text, ActorType),
		userId: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "user_id" }),
		agentName: PG.column(PG.nullable(PG.text), { name: "agent_name" }),
		model: PG.nullable(PG.text),
		capabilitiesJson: PG.column(PG.jsonb(StringList), { name: "capabilities_json", default: [] }),
		createdBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		lastActiveAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_active_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("actors_org_user_idx", ["orgId", "userId"]),
		PG.uniqueIndex("actors_org_agent_name_idx", ["orgId", "agentName"]),
		PG.index("actors_org_type_idx", ["orgId", "type"]),
	],
	tenantColumn: "orgId",
})

/**
 * Persistent identity for an error group (one row per unique fingerprint).
 * Fingerprint = cityHash64(OrgId, ServiceName, ExceptionType, TopFrame),
 * computed in Tinybird error_events_mv and stored here as the decimal
 * UInt64 string (matches `toString(FingerprintHash)` in ClickHouse).
 */
export const ErrorIssues = PG.table("error_issues", {
	columns: {
		id: PG.brand(PG.text, ErrorIssueId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// "alert" issues reuse the error-shaped columns with title/detail
		// semantics: fingerprintHash = `alert:{ruleId}:{groupKey}` (real error
		// fingerprints are decimal UInt64 strings, so the prefix cannot collide),
		// exceptionType = rule name, exceptionMessage = human summary, topFrame = "".
		kind: PG.column(PG.brand(PG.text, IssueKind), { default: "error" }),
		sourceRefJson: PG.column(PG.nullable(PG.jsonb()), { name: "source_ref_json" }),
		fingerprintHash: PG.column(PG.text, { name: "fingerprint_hash" }),
		// Which fingerprint algorithm produced `fingerprintHash`; see
		// FINGERPRINT_VERSION in @maple/domain. Hashes cannot collide across
		// versions, so a row stamped with an older version can never receive
		// another occurrence: retention archives it on sight instead of waiting out
		// the 14-day resolved window with a stale issue sitting in `triage`.
		fingerprintVersion: PG.column(PG.int4, { name: "fingerprint_version", default: 1 }),
		serviceName: PG.column(PG.text, { name: "service_name" }),
		exceptionType: PG.column(PG.text, { name: "exception_type" }),
		exceptionMessage: PG.column(PG.text, { name: "exception_message" }),
		errorLabel: PG.column(PG.text, { name: "error_label", default: "" }),
		topFrame: PG.column(PG.text, { name: "top_frame" }),
		workflowState: PG.column(PG.brand(PG.text, WorkflowState), { name: "workflow_state", default: "triage" }),
		priority: PG.column(PG.int4, { default: 3 }),
		// null = untriaged. Write precedence: manual > ai > detector; see
		// IssueSeveritySource in @maple/domain/http.
		severity: PG.nullable(PG.brand(PG.text, IssueSeverity)),
		severitySource: PG.column(PG.nullable(PG.brand(PG.text, IssueSeveritySource)), { name: "severity_source" }),
		assignedActorId: PG.column(PG.nullable(PG.brand(PG.text, ActorId)), { name: "assigned_actor_id" }),
		leaseHolderActorId: PG.column(PG.nullable(PG.brand(PG.text, ActorId)), { name: "lease_holder_actor_id" }),
		leaseExpiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_expires_at" }),
		claimedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "claimed_at" }),
		notes: PG.nullable(PG.text),
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
		occurrenceCount: PG.column(PG.int4, { name: "occurrence_count", default: 0 }),
		resolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resolved_at" }),
		resolvedByActorId: PG.column(PG.nullable(PG.brand(PG.text, ActorId)), { name: "resolved_by_actor_id" }),
		// Survives a reopen, unlike `resolvedAt` which the regression path nulls.
		// Without it an issue that was fixed and regressed looked identical to one
		// nobody had ever touched; the reason agents kept re-fixing the same bug.
		lastResolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_resolved_at" }),
		lastRegressedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_regressed_at" }),
		regressionCount: PG.column(PG.int4, { name: "regression_count", default: 0 }),
		// Builds this issue has been observed from, and the snapshot taken when it
		// was last resolved. Membership, not ordering: `maple-cli` reports semver
		// while the Workers report git SHAs, so "newer than the fix" is not a
		// question these strings can answer. An occurrence from a build that was
		// already running at resolution time is an old client still in the wild,
		// not a regression. Every build seen in a window is unioned in, not one
		// sampled per tick; a sampled set makes the rule a lottery precisely
		// where clients run many versions at once. Capped, least-recently-seen
		// evicted first; see MAX_TRACKED_VERSIONS.
		seenVersionsJson: PG.column(PG.jsonb(StringList), { name: "seen_versions_json", default: [] }),
		resolvedVersionsJson: PG.column(PG.jsonb(StringList), { name: "resolved_versions_json", default: [] }),
		snoozeUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "snooze_until" }),
		archivedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "archived_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("error_issues_org_fp_idx", ["orgId", "fingerprintHash"]),
		PG.index("error_issues_org_workflow_idx", ["orgId", "workflowState"]),
		PG.index("error_issues_org_severity_idx", ["orgId", "severity"]),
		// The list hot path: org + archived_at IS NULL, ORDER BY last_seen_at
		// DESC, id DESC, LIMIT n; a backward walk over this index streams the
		// page in order instead of collecting the org's rows and sorting
		// (SELECT error_issues was ~630ms p95 on the mobile Home fan-out).
		// Partial and with the id tiebreak, replacing the old
		// error_issues_org_last_seen_idx: only the rare includeArchived list
		// read that one without the archived filter, and it can afford a sort.
		PG.index("error_issues_org_live_seen_idx", ["orgId", "lastSeenAt", "id"], {
			where: `"archived_at" is null`,
		}),
		// Retention sweeps for issues left behind by a fingerprint-algorithm bump.
		// Once a sweep drains them the scan returns nothing, and it stays an index
		// lookup rather than the heap check that `error_issues_org_archived_idx`
		// below was added to prevent.
		PG.index("error_issues_org_fp_version_idx", ["orgId", "fingerprintVersion"]),
		PG.index("error_issues_org_assignee_idx", ["orgId", "assignedActorId"]),
		PG.index("error_issues_lease_expiry_idx", ["leaseExpiresAt"]),
		// The hourly archived-issue purge filters (org_id, archived_at IS NOT NULL,
		// archived_at < cutoff). With no index on archived_at the planner fell back
		// to error_issues_org_assignee_idx and heap-checked the org's whole
		// partition (1,862 rows read per call to return zero, at a 31% buffer-cache
		// hit ratio, which was 35% of ALL database time). Partial, so the index holds
		// only the handful of archived rows.
		PG.index("error_issues_org_archived_idx", ["orgId", "archivedAt"], {
			where: `"archived_at" is not null`,
		}),
	],
	tenantColumn: "orgId",
})

/**
 * Holding area for fingerprints that have been seen but have not yet earned an
 * Issue.
 *
 * Nothing used to stand between "a fingerprint appeared once" and "a durable row
 * plus a first-seen notification", so a single unapplied migration could mint
 * 2,531 issues in three days. A fingerprint accumulates here until it clears
 * PROMOTION_MIN_OCCURRENCES, and only then becomes an Issue; rows that never get
 * there are pruned by retention. Display fields are carried so promotion needs
 * no second warehouse read.
 */
export const ErrorFingerprintCandidates = PG.table("error_fingerprint_candidates", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		fingerprintHash: PG.column(PG.text, { name: "fingerprint_hash" }),
		serviceName: PG.column(PG.text, { name: "service_name" }),
		exceptionType: PG.column(PG.text, { name: "exception_type" }),
		exceptionMessage: PG.column(PG.text, { name: "exception_message" }),
		errorLabel: PG.column(PG.text, { name: "error_label", default: "" }),
		topFrame: PG.column(PG.text, { name: "top_frame" }),
		// Builds seen while the fingerprint was still a candidate, so a promoted
		// issue starts with the set it earned rather than one window's worth.
		serviceVersionsJson: PG.column(PG.jsonb(StringList), { name: "service_versions_json", default: [] }),
		occurrenceCount: PG.column(PG.int4, { name: "occurrence_count", default: 0 }),
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: {
		columns: ["orgId", "fingerprintHash"],
		name: "error_fingerprint_candidates_org_id_fingerprint_hash_pk",
	},
	indexes: [
		// Retention prunes candidates that never reached the threshold.
		PG.index("error_fingerprint_candidates_last_seen_idx", ["orgId", "lastSeenAt"]),
	],
	tenantColumn: "orgId",
})

/**
 * Append-only audit trail of everything that happens to an issue: state
 * transitions, claims, releases, comments, agent reasoning notes, fix
 * proposals. Payload is a JSON blob whose shape depends on the event type.
 */
export const ErrorIssueEvents = PG.table("error_issue_events", {
	columns: {
		id: PG.brand(PG.text, ErrorIssueEventId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		issueId: PG.column(PG.brand(PG.text, ErrorIssueId), { name: "issue_id" }),
		actorId: PG.column(PG.nullable(PG.brand(PG.text, ActorId)), { name: "actor_id" }),
		type: PG.brand(PG.text, ErrorIssueEventType),
		fromState: PG.column(PG.nullable(PG.brand(PG.text, WorkflowState)), { name: "from_state" }),
		toState: PG.column(PG.nullable(PG.brand(PG.text, WorkflowState)), { name: "to_state" }),
		payloadJson: PG.column(PG.jsonb(), { name: "payload_json", default: {} }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("error_issue_events_issue_idx", ["orgId", "issueId", "createdAt"]),
		PG.index("error_issue_events_actor_idx", ["orgId", "actorId", "createdAt"]),
		PG.index("error_issue_events_type_idx", ["orgId", "type", "createdAt"]),
	],
	tenantColumn: "orgId",
})

/**
 * Per-issue evaluator state used by the scheduled error tick to detect
 * regressions and auto-resolve quiet incidents.
 */
export const ErrorIssueStates = PG.table("error_issue_states", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		issueId: PG.column(PG.brand(PG.text, ErrorIssueId), { name: "issue_id" }),
		lastObservedOccurrenceAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_observed_occurrence_at" }),
		lastEvaluatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_evaluated_at" }),
		openIncidentId: PG.column(PG.nullable(PG.brand(PG.text, ErrorIncidentId)), { name: "open_incident_id" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	// No standalone org_id index: the primary key already leads with org_id, so
	// one was pure write amplification on a table taking ~63k updates a day.
	primaryKey: { columns: ["orgId", "issueId"], name: "error_issue_states_org_id_issue_id_pk" },
	tenantColumn: "orgId",
})

/**
 * A time-bounded flare-up under an Issue. Opens on first-seen or regression
 * (activity after the Issue was resolved), auto-resolves after configurable
 * silence (default 30m).
 */
export const ErrorIncidents = PG.table("error_incidents", {
	columns: {
		id: PG.brand(PG.text, ErrorIncidentId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		issueId: PG.column(PG.brand(PG.text, ErrorIssueId), { name: "issue_id" }),
		status: PG.brand(PG.text, ErrorIncidentStatus),
		reason: PG.brand(PG.text, ErrorIncidentReason),
		firstTriggeredAt: PG.column(PG.timestamptzMillis, { name: "first_triggered_at" }),
		lastTriggeredAt: PG.column(PG.timestamptzMillis, { name: "last_triggered_at" }),
		resolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resolved_at" }),
		occurrenceCount: PG.column(PG.int4, { name: "occurrence_count", default: 0 }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("error_incidents_org_issue_idx", ["orgId", "issueId"]),
		PG.index("error_incidents_org_status_idx", ["orgId", "status", "lastTriggeredAt"]),
	],
	tenantColumn: "orgId",
})

/**
 * Per-org policy controlling which alert destinations receive error
 * notifications and under what conditions. Referenced by the scheduled
 * error tick when it opens or auto-resolves incidents.
 */
export const ErrorNotificationPolicies = PG.table("error_notification_policies", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		enabled: PG.column(PG.bool, { default: true }),
		destinationIdsJson: PG.column(PG.jsonb(StringList), { name: "destination_ids_json", default: [] }),
		notifyOnFirstSeen: PG.column(PG.bool, { name: "notify_on_first_seen", default: true }),
		notifyOnRegression: PG.column(PG.bool, { name: "notify_on_regression", default: true }),
		notifyOnResolve: PG.column(PG.bool, { name: "notify_on_resolve", default: false }),
		notifyOnTransitionInReview: PG.column(PG.bool, { name: "notify_on_transition_in_review", default: false }),
		notifyOnTransitionDone: PG.column(PG.bool, { name: "notify_on_transition_done", default: false }),
		notifyOnClaim: PG.column(PG.bool, { name: "notify_on_claim", default: false }),
		minOccurrenceCount: PG.column(PG.int4, { name: "min_occurrence_count", default: 1 }),
		severity: PG.column(PG.brand(PG.text, AlertSeverity), { default: "warning" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

/**
 * Durable per-org checkpoint for the scheduled error evaluator.
 *
 * `processedThrough` is an exclusive minute boundary. A short lease prevents
 * overlapping cron invocations from evaluating the same window; the evaluator
 * advances the checkpoint in the same Postgres transaction as issue/incident
 * mutations.
 */
export const ErrorTickStates = PG.table("error_tick_states", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		processedThrough: PG.column(PG.timestamptzMillis, { name: "processed_through" }),
		bootstrapCompleted: PG.column(PG.bool, { name: "bootstrap_completed", default: false }),
		claimToken: PG.column(PG.nullable(PG.text), { name: "claim_token" }),
		claimExpiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "claim_expires_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["orgId"],
	indexes: [PG.index("error_tick_states_claim_idx", ["claimExpiresAt"])],
	tenantColumn: "orgId",
})

/**
 * Transactional outbox for error-incident notifications. One row represents
 * one logical delivery to one destination and is retried in place. The unique
 * key makes enqueue idempotent when a transaction is retried.
 */
export const ErrorNotificationDeliveries = PG.table("error_notification_deliveries", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		destinationId: PG.column(PG.brand(PG.text, AlertDestinationId), { name: "destination_id" }),
		deliveryKey: PG.column(PG.text, { name: "delivery_key" }),
		payloadJson: PG.column(PG.jsonb(), { name: "payload_json" }),
		status: PG.brand(PG.text, AlertDeliveryStatus),
		attemptCount: PG.column(PG.int4, { name: "attempt_count", default: 0 }),
		scheduledAt: PG.column(PG.timestamptzMillis, { name: "scheduled_at" }),
		claimedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "claimed_at" }),
		claimExpiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "claim_expires_at" }),
		claimedBy: PG.column(PG.nullable(PG.text), { name: "claimed_by" }),
		attemptedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "attempted_at" }),
		errorMessage: PG.column(PG.nullable(PG.text), { name: "error_message" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("error_notification_deliveries_due_idx", ["status", "scheduledAt", "claimExpiresAt"]),
		PG.index("error_notification_deliveries_org_idx", ["orgId"]),
		PG.uniqueIndex("error_notification_deliveries_key_destination_idx", ["deliveryKey", "destinationId"]),
	],
	tenantColumn: "orgId",
})

/**
 * A pull request attached to an issue: the durable half of what `propose_fix`
 * used to record as a bare `prUrl` string on an event payload.
 *
 * The repository is denormalized (`provider` + `repoFullName` + the provider's
 * own `externalRepoId`) rather than carried as a foreign key into
 * `vcs_repositories`. Three reasons, and the first is the load-bearing one:
 *   1. A PR can be attached to an issue for a repository Maple has never synced
 *      (an agent pastes a URL, or the org connected only some of its repos). A
 *      FK would reject exactly the link a user most wants to make.
 *   2. `external_repo_id` is null until a webhook or sync resolves it, so the
 *      merge lookup matches on it when present and on `repo_full_name` otherwise.
 *   3. It keeps this table out of the `vcs.ts` ownership rule (only
 *      `VcsRepository` may import those tables); this one is issue-owned and is
 *      written by the errors services.
 */
export const ErrorIssuePullRequests = PG.table("error_issue_pull_requests", {
	columns: {
		id: PG.brand(PG.text, ErrorIssuePullRequestId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		issueId: PG.column(PG.brand(PG.text, ErrorIssueId), { name: "issue_id" }),
		provider: PG.brand(PG.text, VcsProviderId),
		/** The provider's repo id, once a webhook or sync has resolved one. */
		externalRepoId: PG.column(PG.nullable(PG.text), { name: "external_repo_id" }),
		/** `owner/name`, always known: it is parsed straight out of the PR URL. */
		repoFullName: PG.column(PG.text, { name: "repo_full_name" }),
		number: PG.int4,
		url: PG.text,
		title: PG.nullable(PG.text),
		authorLogin: PG.column(PG.nullable(PG.text), { name: "author_login" }),
		state: PG.column(PG.brand(PG.text, PullRequestLinkState), { default: "open" }),
		mergedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "merged_at" }),
		mergeCommitSha: PG.column(PG.nullable(PG.text), { name: "merge_commit_sha" }),
		linkSource: PG.column(PG.brand(PG.text, PullRequestLinkSource), { name: "link_source" }),
		linkedByActorId: PG.column(PG.nullable(PG.brand(PG.text, ActorId)), { name: "linked_by_actor_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One link per (issue, PR). Makes re-linking idempotent, which matters
		// because three paths can create the same link: `propose_fix`, the manual
		// dialog, and the webhook's body scan.
		PG.uniqueIndex("error_issue_pull_requests_issue_pr_idx", [
			"orgId",
			"issueId",
			"provider",
			"repoFullName",
			"number",
		]),
		// The merge webhook's lookup: "which issues point at this PR?". Keyed on
		// repo_full_name because that is the column always populated; the webhook
		// knows the full name from its own payload.
		PG.index("error_issue_pull_requests_repo_number_idx", ["orgId", "provider", "repoFullName", "number"]),
		PG.index("error_issue_pull_requests_issue_idx", ["orgId", "issueId"]),
	],
	tenantColumn: "orgId",
})

/**
 * One post-merge verification run: the quiet window, the evidence it rests on,
 * and the verdict it reached.
 *
 * `baselineVersionsJson` is the whole rule. It is snapshotted at merge time from
 * the issue's `seen_versions_json` (the identical snapshot `applyTransition`
 * takes into `resolved_versions_json` when an issue is closed) and every later
 * occurrence is judged against it by membership: a build already running when
 * the fix merged is an old client still in the wild, and a build absent from the
 * set is the fix demonstrably not working. Same predicate as `isRegression` in
 * `error-tick-persistence.ts`, applied to a merge rather than to a resolution.
 */
export const ErrorIssueVerifications = PG.table("error_issue_verifications", {
	columns: {
		id: PG.brand(PG.text, ErrorIssueVerificationId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		issueId: PG.column(PG.brand(PG.text, ErrorIssueId), { name: "issue_id" }),
		pullRequestId: PG.column(PG.brand(PG.text, ErrorIssuePullRequestId), { name: "pull_request_id" }),
		status: PG.column(PG.brand(PG.text, VerificationStatus), { default: "waiting" }),
		mergedAt: PG.column(PG.timestamptzMillis, { name: "merged_at" }),
		/** When the window closes and the verification tick may act. */
		verifyAfter: PG.column(PG.timestamptzMillis, { name: "verify_after" }),
		/** Builds the issue had been seen from at merge time. See the note above. */
		baselineVersionsJson: PG.column(PG.jsonb(StringList), { name: "baseline_versions_json", default: [] }),
		baselineOccurrenceCount: PG.column(PG.int4, { name: "baseline_occurrence_count", default: 0 }),
		/**
		 * Pre-merge occurrences per hour. Stored, not re-derived, because it is the
		 * input that chose `verify_after`; without it the window length is an
		 * unexplainable number, and the UI's "waiting ~6h because this fired
		 * ~3x/hour" line has nothing to say.
		 */
		baselineRatePerHour: PG.column(PG.float8, { name: "baseline_rate_per_hour", default: 0 }),
		investigationId: PG.column(PG.nullable(PG.brand(PG.text, InvestigationId)), { name: "investigation_id" }),
		verdict: PG.nullable(PG.brand(PG.text, VerificationVerdict)),
		verdictNote: PG.column(PG.nullable(PG.text), { name: "verdict_note" }),
		/** Occurrences since the merge from builds NOT in the baseline. Zero is the good case. */
		postMergeOccurrenceCount: PG.column(PG.int4, { name: "post_merge_occurrence_count", default: 0 }),
		/** 0 on the first pass; bumped when an inconclusive verdict re-arms a longer window. */
		attempt: PG.column(PG.int4, { default: 0 }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// The tick scan: `status = 'waiting' AND verify_after <= now`. Status
		// leftmost so the scan is an index range over just the waiting rows rather
		// than a walk of every verification that ever ran.
		PG.index("error_issue_verifications_due_idx", ["status", "verifyAfter"]),
		PG.index("error_issue_verifications_issue_idx", ["orgId", "issueId"]),
		// The error tick's short-circuit reads the live verification for an issue it
		// finds in `verifying`; partial so the index holds only rows still in play.
		//
		// UNIQUE on (org, issue) rather than including status: it is also the only
		// real enforcement of "one live verification per issue". The webhook path
		// checks for an open row and then inserts, and the queue consumer runs with
		// `maxConcurrency: 2` with nothing serializing per installation, so two
		// deliveries of the same merge could both pass the check and open two
		// windows that then race to apply contradictory verdicts.
		PG.uniqueIndex("error_issue_verifications_open_idx", ["orgId", "issueId"], {
			where: `"status" in ('waiting', 'running')`,
		}),
	],
	tenantColumn: "orgId",
})

export type ActorRow = PG.SelectRowOf<typeof Actors>
export type ActorInsert = PG.InsertRowOf<typeof Actors>
export type ErrorIssueRow = PG.SelectRowOf<typeof ErrorIssues>
export type ErrorFingerprintCandidateRow = PG.SelectRowOf<typeof ErrorFingerprintCandidates>
export type ErrorFingerprintCandidateInsert = PG.InsertRowOf<typeof ErrorFingerprintCandidates>
export type ErrorIssueStateRow = PG.SelectRowOf<typeof ErrorIssueStates>
export type ErrorIssueEventRow = PG.SelectRowOf<typeof ErrorIssueEvents>
export type ErrorIssueEventInsert = PG.InsertRowOf<typeof ErrorIssueEvents>
export type ErrorIncidentRow = PG.SelectRowOf<typeof ErrorIncidents>
export type ErrorNotificationPolicyRow = PG.SelectRowOf<typeof ErrorNotificationPolicies>
export type ErrorTickStateRow = PG.SelectRowOf<typeof ErrorTickStates>
export type ErrorNotificationDeliveryRow = PG.SelectRowOf<typeof ErrorNotificationDeliveries>
export type ErrorNotificationDeliveryStatus = ErrorNotificationDeliveryRow["status"]
export type ErrorIssuePullRequestRow = PG.SelectRowOf<typeof ErrorIssuePullRequests>
export type ErrorIssuePullRequestInsert = PG.InsertRowOf<typeof ErrorIssuePullRequests>
export type ErrorIssueVerificationRow = PG.SelectRowOf<typeof ErrorIssueVerifications>
export type ErrorIssueVerificationInsert = PG.InsertRowOf<typeof ErrorIssueVerifications>
