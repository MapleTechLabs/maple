/**
 * One Linear issue per alert thread (rule and group), commented on after that; reminders are skipped.
 * Every id Maple sends derives from the delivery, so a retry finds what its first attempt made.
 */
import { createHash } from "node:crypto"
import { type AlertDeliveryFailure, AlertDeliveryTargetMissingError } from "@maple/domain/http"
import { Clock, Effect, Schema } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import { displayGroupKey, formatAlertHeadline, formatSeverityLabel, truncate } from "../../alert-formatting"
import { timestampMs } from "@maple/backend/platform/time"
import type { DispatchResult } from "../context"
import { makeDeliveryError } from "../runTransport"
import type {
	EffectTransport,
	LinearDeliveryPort,
	LinearThread,
	RenderInput,
	SecretConfigOf,
} from "../Transport"

type Config = SecretConfigOf<"linear">
type Input = RenderInput<Config>

/** A trigger within this long of the issue closing reopens it instead of opening another. */
export const LINEAR_REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000

const MAPLE_ICON_URL = "https://maple.dev/logo512.png"
const MAX_TITLE_CHARS = 250
const MAX_BODY_CHARS = 8000
const RESOLVED_BEFORE_OPEN = "**Resolved.** The incident resolved before Maple reached Linear."
/** Under the 30s delivery lease; a token refresh in flight can still overrun it, and re-sends are idempotent. */
const SEND_TIMEOUT = "25 seconds"

/** A UUID v4-shaped id (Linear requires v4) derived from `parts`, so the same event always maps to it. */
export const linearEntityId = (...parts: ReadonlyArray<string>): string => {
	const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex")
	const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const linearThreadKey = (input: Input): string =>
	`${input.context.ruleId}:${input.context.groupKey ?? ""}`

/** Linear priorities: 1 urgent, 2 high, 3 medium. */
const priorityOf = (input: Input) => (input.context.severity === "critical" ? 1 : 2)

export const linearIssueTitle = (input: Input): string =>
	truncate(input.templated?.title ?? formatAlertHeadline(input.context), MAX_TITLE_CHARS)

export const linearIssueDescription = (input: Input): string => {
	const { context } = input
	const group = displayGroupKey(context.groupKey)
	const lines = [
		input.templated?.body ?? buildSummaryLine(context, (value) => `**${value}**`),
		"",
		`- Severity: ${formatSeverityLabel(context.severity)}`,
		...(group === null ? [] : [`- Group: \`${group}\``]),
		...(context.incidentId === null ? [] : [`- Incident: \`${context.incidentId}\``]),
		"",
		`[Open in Maple](${input.linkUrl}) · [Ask Maple AI](${input.chatUrl})`,
	]
	return truncate(lines.join("\n"), MAX_BODY_CHARS)
}

/** What a comment on an existing issue says about this event. */
export const linearCommentBody = (input: Input, thread: LinearThread | null): string => {
	const { context } = input
	const summary = buildSummaryLine(context, (value) => `**${value}**`)
	const sameIncident =
		thread !== null && thread.incidentId !== null && thread.incidentId === context.incidentId
	// Alert incidents re-trigger only on a severity change; error-issue updates carry no tiers.
	const heading =
		context.eventType === "resolve"
			? "Resolved"
			: !sameIncident
				? "Fired again"
				: context.ruleSeverities !== undefined
					? `Severity changed to ${formatSeverityLabel(context.severity).toLowerCase()}`
					: "Updated"
	return `**${heading}.** ${summary}\n\n[Open in Maple](${input.linkUrl})`
}

const IssueStateSchema = Schema.Struct({
	issue: Schema.Struct({
		id: Schema.String,
		identifier: Schema.String,
		url: Schema.String,
		trashed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		archivedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
		completedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
		canceledAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
		state: Schema.Struct({ type: Schema.String }),
		team: Schema.Struct({ id: Schema.String }),
	}),
})
type IssueState = (typeof IssueStateSchema.Type)["issue"]

const TeamSchema = Schema.Struct({
	team: Schema.Struct({
		id: Schema.String,
		key: Schema.String,
		name: Schema.String,
		triageEnabled: Schema.Boolean,
		triageIssueState: Schema.NullOr(Schema.Struct({ id: Schema.String })),
		states: Schema.Struct({
			nodes: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
		}),
	}),
})

const IssueCreateSchema = Schema.Struct({
	issueCreate: Schema.Struct({
		success: Schema.Boolean,
		issue: Schema.NullOr(
			Schema.Struct({ id: Schema.String, identifier: Schema.String, url: Schema.String }),
		),
	}),
})

interface LinearIssueRef {
	readonly id: string
	readonly identifier: string
	readonly url: string
}

const ISSUE_FIELDS = "id identifier url trashed archivedAt completedAt canceledAt state { type } team { id }"

const fetchIssue = (port: LinearDeliveryPort, input: Input, issueId: string) =>
	port
		.request(
			input.context.destination.orgId,
			{
				name: "MapleIssue",
				document: `query MapleIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
				variables: { id: issueId },
			},
			IssueStateSchema,
			{ missingIsNull: true, hiddenIsNull: true },
		)
		.pipe(
			Effect.map((result) => (result === null || result.issue.trashed === true ? null : result.issue)),
		)

const fetchTeam = (port: LinearDeliveryPort, input: Input) =>
	port
		.request(
			input.context.destination.orgId,
			{
				name: "MapleTeam",
				document: `query MapleTeam($id: String!) { team(id: $id) { id key name triageEnabled triageIssueState { id } states(filter: { type: { eq: "unstarted" } }) { nodes { id position } } } }`,
				variables: { id: input.config.teamId },
			},
			TeamSchema,
			{ missingIsNull: true, hiddenIsNull: true },
		)
		.pipe(
			Effect.flatMap((result) =>
				result === null
					? Effect.fail(
							new AlertDeliveryTargetMissingError({
								message: `Linear team ${input.config.teamKey} no longer exists or Maple lost access to it`,
								destinationType: "linear",
							}),
						)
					: Effect.succeed(result.team),
			),
		)

const isClosed = (issue: IssueState) => issue.state.type === "completed" || issue.state.type === "canceled"

const closedAtMs = (issue: IssueState): number | null => {
	const closedAt = issue.completedAt ?? issue.canceledAt ?? null
	if (closedAt === null) return null
	const ms = timestampMs(closedAt)
	return Number.isNaN(ms) ? null : ms
}

/** A comment whose id is derived from the delivery key, so a retry cannot post it twice. */
const comment = (port: LinearDeliveryPort, input: Input, issueId: string, body: string) =>
	port.request(
		input.context.destination.orgId,
		{
			name: "MapleComment",
			document:
				"mutation MapleComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
			variables: {
				input: {
					// Linear ids are workspace-wide and one delivery key can fan out to several destinations.
					id: linearEntityId(
						"comment",
						input.context.destination.id,
						issueId,
						input.context.deliveryKey,
					),
					issueId,
					body,
				},
			},
		},
		Schema.Unknown,
		{ duplicateIsSuccess: true, missingIsNull: true },
	)

/**
 * Every delivery of one incident maps to the same first issue, so racing or retried deliveries
 * find it; a replacement for a closed or deleted issue is keyed by that issue and gets its own id.
 */
const issueIdFor = (input: Input, replacing: string | null) =>
	linearEntityId(
		"issue",
		input.context.destination.id,
		input.config.teamId,
		input.context.incidentId ?? input.context.deliveryKey,
		replacing ?? "",
	)

const createIssue = Effect.fn("LinearTransport.createIssue")(function* (
	port: LinearDeliveryPort,
	input: Input,
	threadKey: string,
	replacing: string | null,
	canFallBack = true,
): Effect.fn.Return<LinearIssueRef, AlertDeliveryFailure> {
	const { context } = input
	const issueId = issueIdFor(input, replacing)
	// Found means an earlier attempt or delivery already made it; use it whatever its state.
	const existing = yield* fetchIssue(port, input, issueId)
	const issue =
		existing ??
		(yield* port
			.request(
				context.destination.orgId,
				{
					name: "MapleIssueCreate",
					document:
						"mutation MapleIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
					variables: {
						input: {
							id: issueId,
							teamId: input.config.teamId,
							title: linearIssueTitle(input),
							description: linearIssueDescription(input),
							priority: priorityOf(input),
						},
					},
				},
				IssueCreateSchema,
				{ duplicateIsSuccess: true },
			)
			.pipe(
				Effect.flatMap((result) =>
					result?.issueCreate.issue
						? Effect.succeed(result.issueCreate.issue)
						: result === null
							? // Taken: a concurrent delivery's issue is reused; one Maple cannot see moves to the next id.
								fetchIssue(port, input, issueId).pipe(
									Effect.flatMap((raced) =>
										raced !== null
											? Effect.succeed(raced)
											: canFallBack
												? createIssue(port, input, threadKey, issueId, false)
												: Effect.fail(
														makeDeliveryError(
															"Linear did not return the created issue",
															"linear",
														),
													),
									),
								)
							: Effect.fail(
									makeDeliveryError("Linear did not return the created issue", "linear"),
								),
				),
			))
	// Linear treats the URL as the attachment's key on an issue, so a retry updates it in place.
	yield* port.request(
		context.destination.orgId,
		{
			name: "MapleIssueLink",
			document:
				"mutation MapleIssueLink($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }",
			variables: {
				input: {
					issueId: issue.id,
					url: input.linkUrl,
					title: "Maple incident",
					subtitle: context.ruleName,
					iconUrl: MAPLE_ICON_URL,
				},
			},
		},
		Schema.Unknown,
	)
	yield* port.saveThread({
		orgId: context.destination.orgId,
		destinationId: context.destination.id,
		threadKey,
		linearTeamId: input.config.teamId,
		linearIssueId: issue.id,
		linearIdentifier: issue.identifier,
		linearUrl: issue.url,
		incidentId: context.incidentId,
	})
	return issue
})

/** Back to Triage when the team uses it, else its first unstarted state. */
const reopen = Effect.fn("LinearTransport.reopen")(function* (
	port: LinearDeliveryPort,
	input: Input,
	issueId: string,
) {
	const team = yield* fetchTeam(port, input)
	const stateId =
		(team.triageEnabled ? team.triageIssueState?.id : undefined) ??
		team.states.nodes.toSorted((a, b) => a.position - b.position)[0]?.id
	if (stateId === undefined) return false
	yield* port.request(
		input.context.destination.orgId,
		{
			name: "MapleIssueReopen",
			document:
				"mutation MapleIssueReopen($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
			variables: { id: issueId, input: { stateId } },
		},
		Schema.Unknown,
	)
	return true
})

const trigger = Effect.fn("LinearTransport.trigger")(function* (
	port: LinearDeliveryPort,
	input: Input,
	nowMs: number,
) {
	const { context } = input
	const threadKey = linearThreadKey(input)
	const thread = yield* port.findThread(context.destination.orgId, context.destination.id, threadKey)
	const issue = thread === null ? null : yield* fetchIssue(port, input, thread.linearIssueId)
	const resolved = context.incidentId !== null && context.incidentStatus === "resolved"
	// Opened for this destination's current team; an issue a person moved since still counts.
	const sameTeam = thread !== null && thread.linearTeamId === input.config.teamId
	// The resolve already reached this thread; a trigger arriving late must not reopen or revive it.
	if (resolved && sameTeam) {
		return {
			providerMessage: "Skipped: the incident resolved before this trigger reached Linear",
			providerReference: thread.linearUrl,
			responseCode: null,
		} satisfies DispatchResult
	}
	const closedAt = issue !== null && isClosed(issue) ? closedAtMs(issue) : null
	const replace =
		thread === null ||
		issue === null ||
		!sameTeam ||
		Boolean(issue.archivedAt) ||
		(issue !== null &&
			isClosed(issue) &&
			(closedAt === null || nowMs - closedAt > LINEAR_REOPEN_WINDOW_MS))
	if (replace) {
		const opened = yield* createIssue(port, input, threadKey, thread?.linearIssueId ?? null)
		// Delivered after its incident resolved: still on record, and marked resolved so nothing dangles.
		if (resolved) {
			yield* comment(port, input, opened.id, RESOLVED_BEFORE_OPEN)
		}
		return {
			providerMessage: `Opened Linear issue ${opened.identifier}`,
			providerReference: opened.url,
			responseCode: null,
		} satisfies DispatchResult
	}
	if (issue !== null && isClosed(issue)) {
		// A person may have moved it to another team, whose states this destination does not know.
		const reopened = issue.team.id === input.config.teamId ? yield* reopen(port, input, issue.id) : false
		yield* comment(port, input, issue.id, linearCommentBody(input, thread))
		yield* port.saveThread({ ...thread, incidentId: input.context.incidentId })
		return {
			providerMessage: `${reopened ? "Reopened" : "Commented on closed"} Linear issue ${issue.identifier}`,
			providerReference: issue.url,
			responseCode: null,
		} satisfies DispatchResult
	}
	yield* comment(port, input, issue.id, linearCommentBody(input, thread))
	if (thread.incidentId !== input.context.incidentId) {
		yield* port.saveThread({ ...thread, incidentId: input.context.incidentId })
	}
	return {
		providerMessage: `Commented on Linear issue ${issue.identifier}`,
		providerReference: issue.url,
		responseCode: null,
	} satisfies DispatchResult
})

const resolve = Effect.fn("LinearTransport.resolve")(function* (port: LinearDeliveryPort, input: Input) {
	const { context } = input
	const threadKey = linearThreadKey(input)
	const saved = yield* port.findThread(context.destination.orgId, context.destination.id, threadKey)
	// A trigger that made its issue but failed before saving the thread still left the issue behind.
	const orphan =
		saved === null && context.incidentId !== null
			? yield* fetchIssue(port, input, issueIdFor(input, null))
			: null
	const thread: LinearThread | null =
		saved ??
		(orphan === null
			? null
			: {
					orgId: context.destination.orgId,
					destinationId: context.destination.id,
					threadKey,
					linearTeamId: input.config.teamId,
					linearIssueId: orphan.id,
					linearIdentifier: orphan.identifier,
					linearUrl: orphan.url,
					incidentId: context.incidentId,
				})
	// The issue stays open: the team closes it once they are done with it.
	if (thread === null) {
		return { providerMessage: "No Linear issue to update", providerReference: null, responseCode: null }
	}
	if (saved === null) yield* port.saveThread(thread)
	const posted = yield* comment(port, input, thread.linearIssueId, linearCommentBody(input, thread))
	// Null is either a retried comment or an issue that is gone; only the second needs saying.
	if (posted === null && (yield* fetchIssue(port, input, thread.linearIssueId)) === null) {
		return {
			providerMessage: `Linear issue ${thread.linearIdentifier} no longer exists`,
			providerReference: null,
			responseCode: null,
		} satisfies DispatchResult
	}
	return {
		providerMessage: `Commented on Linear issue ${thread.linearIdentifier}`,
		providerReference: thread.linearUrl,
		responseCode: null,
	} satisfies DispatchResult
})

export const linearTransport: EffectTransport<Config> = {
	kind: "effect",
	type: "linear",
	peerService: "linear",
	providerLabel: "Linear",
	send: (input, deps) =>
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				"maple.linear.event_type": input.context.eventType,
				"maple.linear.team_key": input.config.teamKey,
			})
			switch (input.context.eventType) {
				case "renotify":
					return {
						providerMessage: "Skipped: Linear issues are not sent reminders",
						providerReference: null,
						responseCode: null,
					} satisfies DispatchResult
				case "test": {
					const team = yield* fetchTeam(deps.linear, input)
					return {
						providerMessage: `Linear team ${team.name} (${team.key}) is reachable`,
						providerReference: null,
						responseCode: null,
					} satisfies DispatchResult
				}
				case "resolve":
					return yield* resolve(deps.linear, input)
				case "trigger":
					return yield* trigger(
						deps.linear,
						input,
						input.context.sentAtMs ?? (yield* Clock.currentTimeMillis),
					)
			}
		}).pipe(
			Effect.timeoutOrElse({
				duration: SEND_TIMEOUT,
				orElse: () => Effect.fail(makeDeliveryError("Linear delivery timed out", "linear")),
			}),
			Effect.withSpan("LinearTransport.send"),
		),
}
