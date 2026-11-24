import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import {
	ErrorIssueAffectedUsersResponse,
	ErrorIssueEventsResponse,
	ErrorIssueId,
	ErrorIssuePullRequestsResponse,
	ErrorIssueVerificationsResponse,
	IssueEscalationAttemptsResponse,
} from "@maple/domain/http"
import type { SymbolicatedStack } from "@maple/domain/errors/js-stack"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../page/contract"
import type { Resources } from "../../platform/resources"
import { Message } from "../../page/errors/issue/message"
import { Model } from "../../page/errors/issue/model"
import { init as pageInit, update as pageUpdate } from "../../page/errors/issue/update"
import { view as pageView } from "../../page/errors/issue/view"
import { defineShellLab } from "../shell-lab"
import { refusalFailure } from "../../page/kit/refusal"
import {
	emptyGrouping,
	emptySimilar,
	GROUPING_STATES,
	type GroupingState,
	longGrouping,
	populatedGrouping,
	populatedSimilar,
} from "../error-grouping-fixture"

// `/lab/error-issue`: the error issue page over one fixture issue, a surging high-severity error
// with a regression, as a member or an analyst, who reads it and gets no triage control
// (`?role=member|analyst&tab=overview|occurrences|activity|grouping`; `context=none` drops the samples'
// release and user, for the table's setup prompt; `grouping=populated|long|empty|loading|error` picks
// what the Grouping tab's reads answer; `stack=raw|resolved|partial|missing_map` picks the source map
// state of the newest stack trace). API Commands are dropped; the page
// is sent the answers its reads would get.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const NOW = Date.UTC(2026, 10, 1, 12)
const WINDOW_MS = 12 * 60 * 60 * 1000
const BUCKETS = 48
const BUCKET_MS = WINDOW_MS / BUCKETS

const warehouseTime = (ms: number) => Str.replace("T", " ")(Str.slice(0, 19)(new Date(ms).toISOString()))
const window = { startTime: warehouseTime(NOW - WINDOW_MS), endTime: warehouseTime(NOW) }

/** A low steady rate that climbs into a surge over the last two hours. */
const timeseries = Array.from({ length: BUCKETS }, (_, i) => ({
	bucket: new Date(NOW - WINDOW_MS + i * BUCKET_MS).toISOString(),
	count: i < 40 ? 4 + ((i * 7) % 9) : 30 + (i - 40) * 22,
}))

const detail = Schema.decodeSync(V2ErrorIssueDetail)({
	id: encodePublicId("iss", issueId),
	object: "error_issue",
	kind: "error",
	fingerprint_hash: "12660752272409977512",
	service_name: "subscriptions-api",
	exception_type: "TypeError",
	exception_message: "Cannot read properties of undefined (reading 'plan')",
	error_label: "TypeError",
	top_frame: "at <anonymous> (/app/apps/subscriptions-api/dist/bundle/server.js)",
	workflow_state: "triage",
	priority: 1,
	severity: "high",
	severity_source: "manual",
	source_ref: null,
	assigned_actor: null,
	lease_holder: null,
	lease_expires_at: null,
	claimed_at: null,
	notes: null,
	first_seen_at: "2026-10-28T09:12:00.000Z",
	last_seen_at: "2026-11-01T11:58:00.000Z",
	occurrence_count: 18_432,
	resolved_at: null,
	last_resolved_at: "2026-10-30T16:00:00.000Z",
	last_regressed_at: "2026-11-01T10:04:00.000Z",
	regression_count: 2,
	resolved_versions: [],
	snooze_until: null,
	archived_at: null,
	has_open_incident: true,
	comment_count: 0,
	open_pull_request_count: 0,
	merged_pull_request_count: 0,
	timeseries,
	sample_traces: Arr.map([3, 9, 14, 26, 41], (minutesAgo, i) => ({
		trace_id: `4bf92f3577b34da6a3ce929d0e0e47${Str.padStart(2, "0")(String(36 + i))}`,
		span_id: `00f067aa0ba902b${i}`,
		service_name: "subscriptions-api",
		timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
		exception_message: "Cannot read properties of undefined (reading 'plan')",
		duration_micros: 18_400 + i * 2_100,
		deployment_environment: i === 3 ? "staging" : "production",
		service_version: i < 3 ? "2026.11.01-4f1c2a9" : "2026.10.30-b81e0d4",
		user_id: i === 2 ? null : (["usr_8f2k1", "usr_02mxq", null, "usr_tl91c", "usr_8f2k1"][i] ?? null),
	})),
	incidents: [
		{
			id: encodePublicId("einc", "0199a006-0000-7000-8000-000000000002"),
			object: "error_incident",
			issue_id: encodePublicId("iss", issueId),
			status: "open",
			reason: "regression",
			first_triggered_at: "2026-11-01T10:04:00.000Z",
			last_triggered_at: "2026-11-01T11:58:00.000Z",
			resolved_at: null,
			occurrence_count: 1_082,
		},
	],
	environments: [
		{ name: "production", count: 1_104 },
		{ name: "staging", count: 96 },
	],
	latest_stacktrace: Arr.join(
		[
			"TypeError: Cannot read properties of undefined (reading 'plan')",
			"    at resolvePlan (/app/apps/subscriptions-api/src/billing/plan.ts:42:28)",
			"    at SubscriptionService.renew (/app/apps/subscriptions-api/src/billing/subscription-service.ts:118:19)",
			"    at async handleRenewal (/app/apps/subscriptions-api/src/routes/renewals.ts:31:5)",
			"    at async /app/node_modules/hono/dist/compose.js:30:17",
		],
		"\n",
	),
})

const affectedUsers = new ErrorIssueAffectedUsersResponse({
	affectedUsers: 214,
	hitsWithUser: 1_031,
	hits: 1_200,
	users: Arr.map(["usr_8f2k1", "usr_02mxq", "usr_tl91c"], (userId, i) => ({
		userId,
		hits: 42 - i * 11,
		lastSeenMs: NOW - (i + 1) * 300_000,
	})),
	attributed: true,
})

/** The same issue with samples that carry no release and no user, as before either is set up. */
const detailWithoutContext: typeof detail = {
	...detail,
	sample_traces: Arr.map(detail.sample_traces, (trace) => ({
		...trace,
		service_version: null,
		user_id: null,
	})),
}

const MINIFIED_STACK = Arr.join(
	[
		"TypeError: Cannot read properties of undefined (reading 'plan')",
		"    at Kc (https://app.acme.dev/assets/index-Bx81.js:1:48213)",
		"    at Object.renew (https://app.acme.dev/assets/index-Bx81.js:1:51877)",
		"    at Ln (https://app.acme.dev/assets/vendor-9d2c.js:2:10442)",
		"    at Pn (https://app.acme.dev/assets/vendor-9d2c.js:2:10661)",
		"    at Hn (https://app.acme.dev/assets/vendor-9d2c.js:2:11020)",
		"    at async Wd (https://app.acme.dev/assets/index-Bx81.js:1:60115)",
		"    at async https://app.acme.dev/assets/vendor-9d2c.js:2:30077",
	],
	"\n",
)

const rawLines = Arr.drop(Str.split(MINIFIED_STACK, "\n"), 1)

/** A frame as the backend writes it; `raw` is the matching minified line. */
const frame = (
	index: number,
	fields: Readonly<{
		function: string | null
		file: string
		line: number
		column: number
		in_app: boolean
		resolved: boolean
		context?: Readonly<{ pre: ReadonlyArray<string>; line: string; post: ReadonlyArray<string> }>
	}>,
) => ({
	raw: Str.trim(rawLines[index] ?? ""),
	function: fields.function,
	file: fields.file,
	line: fields.line,
	column: fields.column,
	in_app: fields.in_app,
	resolved: fields.resolved,
	context: fields.context ?? null,
})

const resolvePlanContext = {
	pre: [
		"export const resolvePlan = (account: Account, catalog: PlanCatalog): Plan => {",
		'\tconst subscription = account.subscriptions.find((s) => s.status === "active")',
		"\t// A trial account has no paid subscription yet.",
		'\tconst tier = subscription?.tier ?? "trial"',
		"",
	],
	line: "\treturn catalog[tier].plan",
	post: [
		"}",
		"",
		"export const planLimits = (plan: Plan) => ({",
		"\tseats: plan.seats,",
		"\tevents: plan.events,",
	],
}

const renewContext = {
	pre: [
		"\tasync renew(accountId: AccountId) {",
		"\t\tconst account = await this.accounts.get(accountId)",
		"\t\tconst catalog = await this.catalog.current()",
		"",
		"\t\t// The plan decides the renewal price.",
	],
	line: "\t\tconst plan = resolvePlan(account, catalog)",
	post: [
		"\t\treturn this.billing.charge(account, plan.price)",
		"\t}",
		"",
		"\tasync cancel(accountId: AccountId) {",
		"\t\tconst account = await this.accounts.get(accountId)",
	],
}

const libraryFrames = [
	frame(2, {
		function: "dispatch",
		file: "node_modules/hono/dist/compose.js",
		line: 30,
		column: 17,
		in_app: false,
		resolved: true,
	}),
	frame(3, {
		function: "Hono.fetch",
		file: "node_modules/hono/dist/hono-base.js",
		line: 188,
		column: 23,
		in_app: false,
		resolved: true,
	}),
	frame(4, {
		function: "handle",
		file: "node_modules/hono/dist/adapter/handle.js",
		line: 12,
		column: 9,
		in_app: false,
		resolved: true,
	}),
]

const topFrames = [
	frame(0, {
		function: "resolvePlan",
		file: "src/billing/plan.ts",
		line: 47,
		column: 28,
		in_app: true,
		resolved: true,
		context: resolvePlanContext,
	}),
	frame(1, {
		function: "SubscriptionService.renew",
		file: "src/billing/subscription-service.ts",
		line: 118,
		column: 19,
		in_app: true,
		resolved: true,
		context: renewContext,
	}),
]

const handleRenewalFrame = frame(5, {
	function: "handleRenewal",
	file: "src/routes/renewals.ts",
	line: 31,
	column: 5,
	in_app: true,
	resolved: true,
	context: {
		pre: ["export const handleRenewal = async (c: Context) => {"],
		line: '\tawait subscriptions.renew(c.req.param("id"))',
		post: ["\treturn c.json({ ok: true })", "}"],
	},
})

const resolvedStack: SymbolicatedStack = {
	status: "resolved",
	frames: [
		...topFrames,
		...libraryFrames,
		handleRenewalFrame,
		frame(6, {
			function: null,
			file: "node_modules/hono/dist/router.js",
			line: 74,
			column: 11,
			in_app: false,
			resolved: true,
		}),
	],
	missing: [],
}

/** The app bundle has a map; the vendor bundle does not, so its frames stay minified. */
const partialStack: SymbolicatedStack = {
	status: "partial",
	frames: [
		...topFrames,
		frame(2, {
			function: "Ln",
			file: "https://app.acme.dev/assets/vendor-9d2c.js",
			line: 2,
			column: 10442,
			in_app: false,
			resolved: false,
		}),
		frame(3, {
			function: "Pn",
			file: "https://app.acme.dev/assets/vendor-9d2c.js",
			line: 2,
			column: 10661,
			in_app: false,
			resolved: false,
		}),
		frame(4, {
			function: "Hn",
			file: "https://app.acme.dev/assets/vendor-9d2c.js",
			line: 2,
			column: 11020,
			in_app: false,
			resolved: false,
		}),
		handleRenewalFrame,
	],
	missing: ["https://app.acme.dev/assets/vendor-9d2c.js"],
}

const missingMapStack: SymbolicatedStack = {
	status: "missing_map",
	frames: Arr.map(rawLines, (raw) => ({
		raw: Str.trim(raw),
		function: null,
		file: null,
		line: null,
		column: null,
		in_app: true,
		resolved: false,
		context: null,
	})),
	missing: ["https://app.acme.dev/assets/index-Bx81.js", "https://app.acme.dev/assets/vendor-9d2c.js"],
}

/** The same issue as each source map state would answer it; `raw` is an API with no symbolicated stack. */
const STACKS = ["raw", "resolved", "partial", "missing_map"] as const
type StackState = (typeof STACKS)[number]

const withStack = (base: typeof detail, state: StackState): typeof detail =>
	state === "raw"
		? base
		: Schema.decodeSync(V2ErrorIssueDetail)({
				...Schema.encodeSync(V2ErrorIssueDetail)(base),
				latest_stacktrace: MINIFIED_STACK,
				latest_stack:
					state === "resolved"
						? resolvedStack
						: state === "partial"
							? partialStack
							: missingMapStack,
			})

/** Reads, writes and the window resolve go to the API; the lab answers them itself. */
const isLocalCommand = (command: { readonly name: string }): boolean =>
	!/^(Fetch|Run|Create|Link|Unlink|Comment|Evaluate|ResolveIssueWindow)/.test(command.name)

type Step = Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const send = (step: Step, message: Message): Step => {
	const next = pageUpdate(step.model, message, context)
	return {
		model: next.model,
		commands: [...step.commands, ...Arr.filter(next.commands ?? [], isLocalCommand)],
	}
}

const ROLES = ["member", "analyst"] as const
const TABS = ["overview", "occurrences", "activity", "grouping"] as const
const CONTEXTS = ["full", "none"] as const
const Flags = Schema.Struct({
	role: Schema.Literals(ROLES),
	tab: Schema.Literals(TABS),
	context: Schema.Literals(CONTEXTS),
	grouping: Schema.Literals(GROUPING_STATES),
	stack: Schema.Literals(STACKS),
})
type Flags = typeof Flags.Type
type LabRole = Flags["role"]
type LabTab = Flags["tab"]

const decodeRole = Schema.decodeUnknownOption(Schema.Literals(ROLES))
const decodeTab = Schema.decodeUnknownOption(Schema.Literals(TABS))
const decodeContext = Schema.decodeUnknownOption(Schema.Literals(CONTEXTS))
const decodeGrouping = Schema.decodeUnknownOption(Schema.Literals(GROUPING_STATES))
const decodeStack = Schema.decodeUnknownOption(Schema.Literals(STACKS))

const LAB_FAILURE = toLoadFailure("Maple couldn't query your telemetry.")

/** What the Grouping tab's two reads answer in each lab state; `null` leaves a read in flight. */
const groupingAnswers = (state: GroupingState) => {
	switch (state) {
		case "populated":
			return { grouping: Result.succeed(populatedGrouping), similar: Result.succeed(populatedSimilar) }
		case "long":
			return { grouping: Result.succeed(longGrouping), similar: Result.succeed(emptySimilar) }
		case "empty":
			return { grouping: Result.succeed(emptyGrouping), similar: Result.succeed(emptySimilar) }
		case "loading":
			return null
		case "error":
			return { grouping: Result.fail(LAB_FAILURE), similar: Result.fail(LAB_FAILURE) }
	}
}

const init = (flags: Flags) => {
	const entered = pageInit({ issueId, search: flags.tab === "overview" ? {} : { tab: flags.tab } }, context)
	const start: Step = { model: entered.model, commands: Arr.filter(entered.commands ?? [], isLocalCommand) }
	// The session's grants for the role, as the page's own read would answer.
	const granted = send(
		start,
		Message.CompletedFetchSession({
			orgId: context.orgId,
			grants: Policy.grantsOf([`org:${flags.role}`]),
		}),
	)
	const windowed = send(granted, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }))
	const keyOf = (
		field: "detail" | "events" | "pullRequests" | "verifications" | "escalations" | "affectedUsers",
	) => windowed.model[field].key ?? ""
	const loaded = Arr.reduce(
		[
			Message.CompletedFetchDetail({
				key: keyOf("detail"),
				result: Result.succeed(
					withStack(flags.context === "none" ? detailWithoutContext : detail, flags.stack),
				),
			}),
			Message.CompletedFetchAffectedUsers({
				key: keyOf("affectedUsers"),
				result: Result.succeed(affectedUsers),
			}),
			Message.CompletedFetchEvents({
				key: keyOf("events"),
				result: Result.succeed(new ErrorIssueEventsResponse({ events: [] })),
			}),
			Message.CompletedFetchPullRequests({
				key: keyOf("pullRequests"),
				result: Result.succeed(
					new ErrorIssuePullRequestsResponse({ pullRequests: [], suggestedRepository: null }),
				),
			}),
			Message.CompletedFetchVerifications({
				key: keyOf("verifications"),
				result: Result.succeed(new ErrorIssueVerificationsResponse({ verifications: [] })),
			}),
			Message.CompletedFetchEscalations({
				key: keyOf("escalations"),
				result: Result.succeed(new IssueEscalationAttemptsResponse({ attempts: [] })),
			}),
		],
		windowed,
		send,
	)
	// The Grouping tab reads once the detail is in; answer those reads with the picked state.
	const answers = groupingAnswers(flags.grouping)
	if (answers === null || flags.tab !== "grouping") return loaded
	return Arr.reduce(
		[
			Message.CompletedFetchGrouping({
				key: loaded.model.grouping.key ?? "",
				result: answers.grouping,
			}),
			Message.CompletedFetchSimilar({ key: loaded.model.similar.key ?? "", result: answers.similar }),
		],
		loaded,
		send,
	)
}

/** The lab has no API, so a started investigation is answered at once with the failure the page shows. */
const NO_API = Message.CompletedCreateInvestigation({
	result: Result.fail(toLoadFailure("The lab has no API to start an investigation.")),
})

/** A split or merge the lab cannot send settles at once with the message the page shows. */
const groupingAnswer = (message: Message): Message | null => {
	if (message._tag === "ClickedSplitOut")
		return Message.CompletedSplitOut({
			fingerprintHash: message.fingerprintHash,
			result: Result.fail(
				refusalFailure(
					"Couldn't split out the fingerprint",
					"The lab has no API to split out a fingerprint.",
				),
			),
		})
	if (message._tag === "ClickedMergeSimilar")
		return Message.CompletedMergeSimilar({
			sourceIssueId: message.sourceIssueId,
			result: Result.fail(
				refusalFailure("Couldn't merge the issue", "The lab has no API to merge issues."),
			),
		})
	return null
}

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, context)
	const answer = groupingAnswer(message)
	if (answer !== null) {
		const settled = pageUpdate(next.model, answer, context)
		return { model: settled.model, commands: Arr.filter(settled.commands ?? [], isLocalCommand) }
	}
	const commands = next.commands ?? []
	if (!Arr.some(commands, (command) => command.name === "CreateErrorIssueInvestigation"))
		return { model: next.model, commands: Arr.filter(commands, isLocalCommand) }
	const settled = pageUpdate(next.model, NO_API, context)
	return {
		model: settled.model,
		commands: Arr.filter([...commands, ...(settled.commands ?? [])], isLocalCommand),
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "error-issue-lab",
		model,
		view: pageView,
		viewInputs: { context },
		toParentMessage: (message: Message) => message,
	})

export const lab = defineShellLab("Error issue", {
	Model,
	Message,
	Flags,
	flags: Effect.sync((): Flags => {
		const params = new URLSearchParams(globalThis.location.search)
		return {
			role: Option.getOrElse(decodeRole(params.get("role")), (): LabRole => "member"),
			tab: Option.getOrElse(decodeTab(params.get("tab")), (): LabTab => "overview"),
			context: Option.getOrElse(decodeContext(params.get("context")), (): Flags["context"] => "full"),
			grouping: Option.getOrElse(
				decodeGrouping(params.get("grouping")),
				(): GroupingState => "populated",
			),
			stack: Option.getOrElse(decodeStack(params.get("stack")), (): StackState => "raw"),
		}
	}),
	init,
	update,
	view,
	currentPath: "/errors",
	breadcrumbs: [{ label: "Errors" }, { label: "TypeError" }],
})
