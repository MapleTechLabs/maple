import { OrgId } from "@maple/domain"
import {
	ErrorIssueEventsResponse,
	ErrorIssueId,
	ErrorIssuePullRequestsResponse,
	IssueEscalationAttemptsResponse,
} from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import type { PageContext } from "../../contract"
import { MountRightRail } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An analyst reads the issue; state, severity, the lease, merges, pull request links and
// comments need `error_issues:triage`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const MEMBER = Policy.grantsOf(["org:member"])
const ANALYST = Policy.grantsOf(["org:analyst"])

const holder = {
	id: encodePublicId("actor", "0199a005-0000-7000-8000-000000000001"),
	type: "agent",
	user_id: null,
	agent_name: "triage-bot",
	model: null,
	capabilities: [],
	last_active_at: null,
}

const HELD = {
	lease_holder: holder,
	lease_expires_at: "2026-10-01T12:05:00.000Z",
	claimed_at: "2026-10-01T11:50:00.000Z",
}
const MERGED = {
	merged_into_issue_id: encodePublicId("iss", "0199a004-0000-7000-8000-000000000002"),
}

const detailOf = (overrides: Readonly<Record<string, unknown>>) =>
	Schema.decodeSync(V2ErrorIssueDetail)({
		id: encodePublicId("iss", issueId),
		object: "error_issue",
		kind: "error",
		fingerprint_hash: "12660752272409977512",
		service_name: "payment-svc",
		exception_type: "ConnectionTimeout",
		exception_message: "timed out acquiring a connection",
		error_label: "ConnectionTimeout",
		top_frame: "",
		workflow_state: "in_progress",
		priority: 1,
		severity: "high",
		severity_source: null,
		source_ref: null,
		assigned_actor: null,
		lease_holder: null,
		lease_expires_at: null,
		claimed_at: null,
		notes: null,
		first_seen_at: "2026-10-01T10:00:00.000Z",
		last_seen_at: "2026-10-01T11:44:00.000Z",
		occurrence_count: 12,
		resolved_at: null,
		last_resolved_at: null,
		last_regressed_at: null,
		regression_count: 0,
		resolved_versions: [],
		snooze_until: null,
		archived_at: null,
		has_open_incident: false,
		comment_count: 0,
		open_pull_request_count: 0,
		merged_pull_request_count: 0,
		timeseries: [],
		sample_traces: [],
		incidents: [],
		environments: [],
		...overrides,
	})

const pullRequests = Schema.decodeSync(ErrorIssuePullRequestsResponse)({
	pullRequests: [
		{
			id: "0199a007-0000-7000-8000-000000000001",
			issueId,
			provider: "github",
			repoFullName: "acme/payments",
			number: 412,
			url: "https://github.com/acme/payments/pull/412",
			title: "Raise the pool timeout",
			authorLogin: "sam",
			state: "open",
			mergedAt: null,
			mergeCommitSha: null,
			linkSource: "user",
			linkedByActor: null,
			createdAt: "2026-10-01T11:00:00.000Z",
		},
	],
	suggestedRepository: null,
})

const events = Schema.decodeSync(ErrorIssueEventsResponse)({
	events: [
		{
			id: "0199a008-0000-7000-8000-000000000001",
			issueId,
			actor: null,
			type: "state_change",
			fromState: "triage",
			toState: "in_progress",
			payload: {},
			createdAt: "2026-10-01T11:30:00.000Z",
		},
	],
})

type Fixture = Readonly<{
	grants: ReadonlyArray<Policy.Permission>
	detail?: Readonly<Record<string, unknown>>
	tab?: "activity"
	hasPullRequest?: boolean
}>

/** Entered with the session's grants and every read the page shows answered. */
const loaded = (fixture: Fixture): Model => {
	const entered = init({ issueId, search: fixture.tab === undefined ? {} : { tab: fixture.tab } }, context)
	const windowed = Arr.reduce(
		[
			Message.CompletedFetchSession({ orgId, grants: fixture.grants }),
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		],
		entered.model,
		(model, message) => pageUpdate(model, message).model,
	)
	const model = Arr.reduce(
		[
			Message.CompletedFetchDetail({
				key: windowed.detail.key ?? "",
				result: Result.succeed(detailOf(fixture.detail ?? {})),
			}),
			Message.CompletedFetchEvents({ key: windowed.events.key ?? "", result: Result.succeed(events) }),
			Message.CompletedFetchEscalations({
				key: windowed.escalations.key ?? "",
				result: Result.succeed(new IssueEscalationAttemptsResponse({ attempts: [] })),
			}),
			Message.CompletedFetchPullRequests({
				key: windowed.pullRequests.key ?? "",
				result: Result.succeed(
					(fixture.hasPullRequest ?? false)
						? pullRequests
						: new ErrorIssuePullRequestsResponse({ pullRequests: [], suggestedRepository: null }),
				),
			}),
		],
		windowed,
		(model, message) => pageUpdate(model, message).model,
	)
	return { ...model, isRightRailMounted: true }
}

const mounted = [
	Mount.resolve(MountRightRail, Message.MountedRightRail()),
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
] as const

describe("error issue for an analyst", () => {
	test("the rail reads state and severity and offers no pick, claim or attach", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST })),
			...mounted,
			expectView(text("In progress")).toExist(),
			expectView(text("High")).toExist(),
			expectView(text("Unclaimed")).toExist(),
			expectView(role("combobox")).toBeAbsent(),
			expectView(role("button", { name: "Claim" })).toBeAbsent(),
			expectView(role("button", { name: "Attach" })).toBeAbsent(),
			expectView(role("button", { name: "Attach the PR that fixes this" })).toBeAbsent(),
		)
	})

	test("a member picks state and severity, claims and attaches", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER })),
			...mounted,
			expectView(role("combobox", { name: "In progress" })).toExist(),
			expectView(role("combobox", { name: "Severity" })).toExist(),
			expectView(role("button", { name: "Claim" })).toExist(),
			expectView(role("button", { name: "Attach" })).toExist(),
			expectView(role("button", { name: "Attach the PR that fixes this" })).toExist(),
		)
	})

	test("a held lease shows its countdown without Extend or Release", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST, detail: HELD })),
			...mounted,
			expectView(text("Active lease")).toExist(),
			expectView(text("5:00")).toExist(),
			expectView(role("button", { name: "Extend" })).toBeAbsent(),
			expectView(role("button", { name: "Release" })).toBeAbsent(),
		)
	})

	test("a member extends and releases a held lease", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER, detail: HELD })),
			...mounted,
			expectView(role("button", { name: "Extend" })).toExist(),
			expectView(role("button", { name: "Release" })).toExist(),
		)
	})

	test("a merged issue says where it went and offers no Unmerge", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST, detail: MERGED })),
			...mounted,
			expectView(text("Merged into another issue")).toExist(),
			expectView(role("link", { name: "the issue it was merged into" })).toExist(),
			expectView(role("button", { name: "Unmerge" })).toBeAbsent(),
		)
	})

	test("a member unmerges a merged issue", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER, detail: MERGED })),
			...mounted,
			expectView(role("button", { name: "Unmerge" })).toExist(),
		)
	})

	test("a linked pull request is a link with no detach", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST, hasPullRequest: true })),
			...mounted,
			expectView(role("link", { name: "acme/payments#412" })).toExist(),
			expectView(role("button", { name: "Detach acme/payments#412" })).toBeAbsent(),
		)
	})

	test("a member detaches a linked pull request", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER, hasPullRequest: true })),
			...mounted,
			expectView(role("button", { name: "Detach acme/payments#412" })).toExist(),
		)
	})

	test("the activity tab keeps the timeline and has no comment box", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST, tab: "activity" })),
			...mounted,
			expectView(text("triage → in_progress")).toExist(),
			expectView(role("textbox")).toBeAbsent(),
			expectView(role("button", { name: "Comment" })).toBeAbsent(),
		)
	})

	test("a member comments from the activity tab", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER, tab: "activity" })),
			...mounted,
			expectView(role("textbox")).toExist(),
			expectView(role("button", { name: "Comment" })).toExist(),
		)
	})

	test("an analyst is not offered an investigation or the agent prompt, and a member is", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST })),
			...mounted,
			expectView(role("button", { name: "Start investigation" })).toBeAbsent(),
			expectView(role("button", { name: "Copy agent prompt" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER })),
			...mounted,
			expectView(role("button", { name: "Start investigation" })).toExist(),
			expectView(role("button", { name: "Copy agent prompt" })).toExist(),
		)
	})

	test("grants answered for another org are dropped", () => {
		const other = Schema.decodeSync(OrgId)("org_other")
		const model = pageUpdate(
			loaded({ grants: MEMBER }),
			Message.CompletedFetchSession({ orgId: other, grants: ANALYST }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			...mounted,
			expectView(role("button", { name: "Claim" })).toExist(),
		)
	})
})
