import { OrgId } from "@maple/domain"
import {
	ErrorIssueEventsResponse,
	ErrorIssueId,
	ErrorIssuePullRequestsResponse,
	ErrorIssueVerificationsResponse,
	IssueEscalationAttemptsResponse,
} from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageContext } from "../../page/contract"
import type { Resources } from "../../platform/resources"
import { Message } from "../../page/errors/issue/message"
import { Model } from "../../page/errors/issue/model"
import { init as pageInit, update as pageUpdate } from "../../page/errors/issue/update"
import { view as pageView } from "../../page/errors/issue/view"
import { defineShellLab } from "../shell-lab"

// `/lab/error-issue`: the error issue page over one fixture issue, a surging high-severity error
// with a regression. API Commands are dropped; the page is sent the answers its reads would get.

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

const warehouseTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")
const window = { startTime: warehouseTime(NOW - WINDOW_MS), endTime: warehouseTime(NOW) }

/** A low steady rate that climbs into a surge over the last two hours. */
const timeseries = Array.from({ length: BUCKETS }, (_, i) => ({
	bucket: new Date(NOW - WINDOW_MS + i * BUCKET_MS).toISOString(),
	count: i < 40 ? 4 + ((i * 7) % 9) : 30 + (i - 40) * 22,
}))

const detail = Schema.decodeUnknownSync(V2ErrorIssueDetail)({
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
	sample_traces: [],
	incidents: [],
	environments: [{ name: "production", count: 1_740 }],
})

/** Reads, writes and the window resolve go to the API; the lab answers them itself. */
const isLocalCommand = (command: { readonly name: string }): boolean =>
	!/^(Fetch|Run|Create|Link|Unlink|Comment|Evaluate|ResolveIssueWindow)/.test(command.name)

type Step = Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const send = (step: Step, message: Message): Step => {
	const next = pageUpdate(step.model, message, context)
	return {
		model: next.model,
		commands: [...step.commands, ...(next.commands ?? []).filter(isLocalCommand)],
	}
}

const Flags = Schema.Struct({})

const init = () => {
	const entered = pageInit({ issueId, search: {} }, context)
	const start: Step = { model: entered.model, commands: (entered.commands ?? []).filter(isLocalCommand) }
	const windowed = send(start, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }))
	const keyOf = (field: "detail" | "events" | "pullRequests" | "verifications" | "escalations") =>
		windowed.model[field].key ?? ""
	return [
		Message.CompletedFetchDetail({ key: keyOf("detail"), result: Result.succeed(detail) }),
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
	].reduce(send, windowed)
}

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, context)
	return { model: next.model, commands: (next.commands ?? []).filter(isLocalCommand) }
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
	flags: Effect.succeed({}),
	init,
	update,
	view,
	currentPath: "/errors",
	breadcrumbs: [{ label: "Errors" }, { label: "TypeError" }],
})
