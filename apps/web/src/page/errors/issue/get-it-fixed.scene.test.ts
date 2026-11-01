import { OrgId } from "@maple/domain"
import { ErrorIssueId } from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { agentPromptFromIssue } from "../../../components/errors/agent-debug-prompt"
import { errorIssueDetailFromV2 } from "../../../lib/services/error-issues"
import * as CopyButton from "../../../ui/copy-button"
import type { PageContext } from "../../contract"
import { CreateInvestigation } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { getItFixedPanel } from "./view-agent-handoff"

// The Get it fixed panel hands the issue's agent prompt to the clipboard in one click.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.UTC(2026, 9, 1, 12)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const wire = Schema.decodeUnknownSync(V2ErrorIssueDetail)({
	id: encodePublicId("iss", issueId),
	object: "error_issue",
	kind: "error",
	fingerprint_hash: "12660752272409977512",
	service_name: "payment-svc",
	exception_type: "ConnectionTimeout",
	exception_message: "timed out acquiring a connection",
	error_label: "ConnectionTimeout",
	top_frame: "at acquire (pool.ts:42)",
	workflow_state: "triage",
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
})
const issue = errorIssueDetailFromV2(wire).issue

const loaded = (): Model => {
	const windowed = pageUpdate(
		init({ issueId, search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		windowed,
		Message.CompletedFetchDetail({ key: windowed.detail.key ?? "", result: Result.succeed(wire) }),
	).model
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => getItFixedPanel(h, model, issue, null)

describe("get it fixed", () => {
	test("Copy prompt puts the issue's agent prompt on the clipboard, then says Copied", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			click(role("button", { name: "Copy agent prompt" })),
			Command.expectExact(
				CopyButton.WriteClipboard({ text: agentPromptFromIssue(issue), generation: 1 }),
			),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			expectView(role("button", { name: "Copy agent prompt" })).toHaveAttr(
				"data-copy-status",
				"copied",
			),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
			expectView(role("button", { name: "Copy agent prompt" })).toHaveAttr("data-copy-status", "idle"),
		)
	})

	test("without a linked investigation the panel offers to start one", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			click(role("button", { name: "Start investigation" })),
			expectView(role("button", { name: "Starting…" })).toBeDisabled(),
			Command.resolve(
				CreateInvestigation,
				Message.CompletedCreateInvestigation({ result: Result.succeed("inv_1") }),
			),
		)
	})
})
