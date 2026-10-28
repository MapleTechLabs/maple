/**
 * One Linear issue per alert thread (rule and group), commented on after that; reminders are skipped.
 * Every id Maple sends derives from the delivery, so a retry finds what its first attempt made.
 */
import { createHash } from "node:crypto"
import { AlertDeliveryTargetMissingError } from "@maple/domain/http"
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
/** Under the 30s delivery lease, so a slow Linear never lets a second worker run the same row. */
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

const ISSUE_FIELDS = "id identifier url trashed archivedAt completedAt canceledAt state { type }"

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
			{ notFoundIsNull: true },
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
			{ notFoundIsNull: true },
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
		{ duplicateIsSuccess: true },
	)

const createIssue = Effect.fn("LinearTransport.createIssue")(function* (
	port: LinearDeliveryPort,
	input: Input,
	threadKey: string,
) {
	const { context } = input
	// Keyed by the delivery, not the incident: a replacement issue for the same incident needs a new id.
	const issueId = linearEntityId("issue", context.destination.id, context.deliveryKey)
	const found = yield* fetchIssue(port, input, issueId)
	const existing = found !== null && !found.archivedAt && !isClosed(found) ? found : null
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
			)
			.pipe(
				Effect.flatMap((result) =>
					result?.issueCreate.issue
						? Effect.succeed(result.issueCreate.issue)
						: Effect.fail(makeDeliveryError("Linear did not return the created issue", "linear")),
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
		linearIssueId: issue.id,
		linearIdentifier: issue.identifier,
		linearUrl: issue.url,
		incidentId: context.incidentId,
	})
	return {
		providerMessage: `Opened Linear issue ${issue.identifier}`,
		providerReference: issue.url,
		responseCode: null,
	} satisfies DispatchResult
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
	// A trigger retried after its incident resolved must not open an issue nothing will resolve.
	if (thread === null && context.incidentId !== null && context.incidentStatus === "resolved") {
		return {
			providerMessage: "Skipped: the incident resolved before Linear was reached",
			providerReference: null,
			responseCode: null,
		} satisfies DispatchResult
	}
	const issue = thread === null ? null : yield* fetchIssue(port, input, thread.linearIssueId)
	if (thread === null || issue === null || issue.archivedAt) {
		return yield* createIssue(port, input, threadKey)
	}
	if (isClosed(issue)) {
		const closedAt = closedAtMs(issue)
		if (closedAt === null || nowMs - closedAt > LINEAR_REOPEN_WINDOW_MS) {
			return yield* createIssue(port, input, threadKey)
		}
		const reopened = yield* reopen(port, input, issue.id)
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
	const { destination } = input.context
	const thread = yield* port.findThread(destination.orgId, destination.id, linearThreadKey(input))
	// The issue stays open: the team closes it once they are done with it.
	if (thread === null) {
		return { providerMessage: "No Linear issue to update", providerReference: null, responseCode: null }
	}
	yield* comment(port, input, thread.linearIssueId, linearCommentBody(input, thread))
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
