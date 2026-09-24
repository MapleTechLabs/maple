/**
 * Output schemas for the error-issue MCP tools. Where a tool already sent a `__maple_ui` payload,
 * its schema matches the `*Data` interface in `mcp-structured-types.ts` field for field; extra
 * fields carry what the rendered text needs.
 */
import { Schema } from "effect"

export const IssueActorSummary = Schema.Struct({
	id: Schema.String,
	type: Schema.Literals(["user", "agent"]),
	userId: Schema.NullOr(Schema.String),
	agentName: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	capabilities: Schema.Array(Schema.String),
})

export const ErrorIssueRow = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	fingerprintHash: Schema.String,
	workflowState: Schema.String,
	priority: Schema.Number,
	severity: Schema.NullOr(Schema.String),
	severitySource: Schema.NullOr(Schema.String),
	serviceName: Schema.String,
	exceptionType: Schema.String,
	exceptionMessage: Schema.String,
	topFrame: Schema.String,
	occurrenceCount: Schema.Number,
	firstSeenAt: Schema.String,
	lastSeenAt: Schema.String,
	assignedActor: Schema.NullOr(IssueActorSummary),
	leaseHolder: Schema.NullOr(IssueActorSummary),
	leaseExpiresAt: Schema.NullOr(Schema.String),
	notes: Schema.NullOr(Schema.String),
	hasOpenIncident: Schema.Boolean,
	/** Fix history and the display label, which the text's History and Exception columns read. */
	errorLabel: Schema.String,
	regressionCount: Schema.Number,
	lastResolvedAt: Schema.NullOr(Schema.String),
})

/** The `compact: true` row: identity, state and volume; no assignment, lease or notes. */
export const ErrorIssueCompactRow = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	fingerprintHash: Schema.String,
	workflowState: Schema.String,
	severity: Schema.NullOr(Schema.String),
	serviceName: Schema.String,
	errorLabel: Schema.String,
	occurrenceCount: Schema.Number,
	firstSeenAt: Schema.String,
	lastSeenAt: Schema.String,
	regressionCount: Schema.Number,
	lastResolvedAt: Schema.NullOr(Schema.String),
	hasOpenIncident: Schema.Boolean,
})

export const ListErrorIssuesOutput = Schema.Struct({
	compact: Schema.Boolean,
	issues: Schema.Union([Schema.Array(ErrorIssueRow), Schema.Array(ErrorIssueCompactRow)]),
	total: Schema.Number,
	/** The filters that applied. */
	filters: Schema.Struct({
		workflowState: Schema.optionalKey(Schema.String),
		severity: Schema.optionalKey(Schema.String),
		kind: Schema.optionalKey(Schema.String),
		service: Schema.optionalKey(Schema.String),
		lastSeenAfter: Schema.optionalKey(Schema.String),
		includeArchived: Schema.Boolean,
		limit: Schema.Number,
	}),
})

export const TransitionErrorIssueOutput = Schema.Struct({
	id: Schema.String,
	workflowState: Schema.String,
	/** Always "": the service returns only the issue after the move. */
	fromState: Schema.String,
	toState: Schema.String,
	assignedActorId: Schema.NullOr(Schema.String),
	leaseHolderActorId: Schema.NullOr(Schema.String),
	snoozeUntil: Schema.NullOr(Schema.String),
	serviceName: Schema.String,
	exceptionType: Schema.String,
	note: Schema.optionalKey(Schema.String),
})

export const SetIssueSeverityOutput = Schema.Struct({
	id: Schema.String,
	severity: Schema.NullOr(Schema.String),
	severitySource: Schema.NullOr(Schema.String),
	/** False when an AI write was blocked by a manual override. */
	applied: Schema.Boolean,
	workflowState: Schema.String,
	serviceName: Schema.String,
	note: Schema.optionalKey(Schema.String),
})

export const ClaimErrorIssueOutput = Schema.Struct({
	id: Schema.String,
	workflowState: Schema.String,
	leaseHolderActorId: Schema.String,
	leaseExpiresAt: Schema.String,
	claimedAt: Schema.String,
	/** The lease holder's agent name or user id. */
	holder: Schema.String,
})

export const ReleaseErrorIssueOutput = Schema.Struct({
	id: Schema.String,
	workflowState: Schema.String,
	previousLeaseHolderActorId: Schema.NullOr(Schema.String),
})

export const CommentOnErrorIssueOutput = Schema.Struct({
	eventId: Schema.String,
	issueId: Schema.String,
	type: Schema.Literals(["comment", "agent_note"]),
	actorId: Schema.NullOr(Schema.String),
	/** The commenting actor's agent name or user id. */
	actor: Schema.String,
})

export const ProposeFixOutput = Schema.Struct({
	issueId: Schema.String,
	workflowState: Schema.String,
	prUrl: Schema.NullOr(Schema.String),
})

export const LinkPullRequestOutput = Schema.Struct({
	pullRequestId: Schema.String,
	issueId: Schema.String,
	repoFullName: Schema.String,
	number: Schema.Number,
	url: Schema.String,
	state: Schema.Literals(["open", "merged", "closed"]),
})

export const ErrorIssueEventRow = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	fromState: Schema.NullOr(Schema.String),
	toState: Schema.NullOr(Schema.String),
	actorId: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	payload: Schema.Record(Schema.String, Schema.Json),
	/** `agent:<name>`, a user id, or `system`. */
	actor: Schema.String,
})

export const ListErrorIssueEventsOutput = Schema.Struct({
	issueId: Schema.String,
	events: Schema.Array(ErrorIssueEventRow),
	total: Schema.Number,
	/** The page size asked for; a full page may mean older events were left out. */
	limit: Schema.Number,
})

export const RegisterAgentOutput = Schema.Struct({
	id: Schema.String,
	agentName: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	capabilities: Schema.Array(Schema.String),
})

export const ErrorIncidentRow = Schema.Struct({
	id: Schema.String,
	issueId: Schema.String,
	status: Schema.String,
	reason: Schema.String,
	firstTriggeredAt: Schema.String,
	lastTriggeredAt: Schema.String,
	resolvedAt: Schema.NullOr(Schema.String),
	occurrenceCount: Schema.Number,
})

export const ListErrorIncidentsOutput = Schema.Struct({
	incidents: Schema.Array(ErrorIncidentRow),
	total: Schema.Number,
	openCount: Schema.Number,
	/** Set when the list was narrowed to one issue; absent means org-wide open incidents. */
	issueId: Schema.optionalKey(Schema.String),
})

export const UpdateErrorNotificationPolicyOutput = Schema.Struct({
	enabled: Schema.Boolean,
	destinationIds: Schema.Array(Schema.String),
	notifyOnFirstSeen: Schema.Boolean,
	notifyOnRegression: Schema.Boolean,
	notifyOnResolve: Schema.Boolean,
	minOccurrenceCount: Schema.Number,
	severity: Schema.String,
})
