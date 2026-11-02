import { ErrorIssueId } from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { errorIssueDetailFromV2 } from "../../../lib/services/error-issues"
import type { Message } from "./message"
import { issueStats, type StatInputs } from "./view-overview"

// The stat rail's trend and fix-history sub-lines read what the window and the issue support.

const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const NOW = Date.UTC(2026, 9, 1, 12)

const issueWith = (
	history: Readonly<{ lastRegressedAt: string | null; lastResolvedAt: string | null }>,
	kind: "error" | "alert" = "error",
) =>
	errorIssueDetailFromV2(
		Schema.decodeUnknownSync(V2ErrorIssueDetail)({
			id: encodePublicId("iss", issueId),
			object: "error_issue",
			kind,
			fingerprint_hash: "12660752272409977512",
			service_name: "payment-svc",
			exception_type: "ConnectionTimeout",
			exception_message: "timed out acquiring a connection",
			error_label: "ConnectionTimeout",
			top_frame: "",
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
			first_seen_at: "2026-09-28T10:00:00.000Z",
			last_seen_at: "2026-10-01T11:44:00.000Z",
			occurrence_count: 120,
			resolved_at: null,
			last_resolved_at: history.lastResolvedAt,
			last_regressed_at: history.lastRegressedAt,
			regression_count: history.lastRegressedAt === null ? 0 : 1,
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
		}),
	).issue

type Model = Readonly<{
	surge: number | null
	windowCount: number
	history: Parameters<typeof issueWith>[0]
	kind?: "error" | "alert"
}>

const inputsOf = (model: Model): StatInputs => ({
	windowCount: model.windowCount,
	windowLabel: "12h",
	spark: [],
	surge: model.surge,
	timeZone: "UTC",
	nowMs: NOW,
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	issueStats(h, issueWith(model.history, model.kind), inputsOf(model))
const update = (model: Model) => ({ model, commands: [] })
const noHistory = { lastRegressedAt: null, lastResolvedAt: null }

describe("issue stats", () => {
	test("a surge reads its rate, a drop reads Fading, the middle reads Steady", () => {
		scene(
			{ update, view },
			given<Model>({ surge: 3.2, windowCount: 90, history: noHistory }),
			expectView(text("3.2x the usual rate")).toExist(),
		)
		scene(
			{ update, view },
			given<Model>({ surge: 0.3, windowCount: 90, history: noHistory }),
			expectView(text("Fading, 0.3x the usual rate")).toExist(),
		)
		scene(
			{ update, view },
			given<Model>({ surge: 1.1, windowCount: 90, history: noHistory }),
			expectView(text("Steady in this window")).toExist(),
		)
	})

	test("a window too thin to call says nothing about the trend", () => {
		scene(
			{ update, view },
			given<Model>({ surge: null, windowCount: 3, history: noHistory }),
			expectView(text("Steady in this window")).not.toExist(),
			expectView(text(/usual rate/)).not.toExist(),
		)
	})

	test("a fix after the last regression reads as holding, not as the old regression", () => {
		scene(
			{ update, view },
			given<Model>({
				surge: null,
				windowCount: 3,
				history: {
					lastRegressedAt: "2026-09-29T10:00:00.000Z",
					lastResolvedAt: "2026-09-30T10:00:00.000Z",
				},
			}),
			expectView(text(/fix held since/)).toExist(),
			expectView(text(/regressed/)).not.toExist(),
		)
		scene(
			{ update, view },
			given<Model>({
				surge: null,
				windowCount: 3,
				history: {
					lastRegressedAt: "2026-09-30T12:00:00.000Z",
					lastResolvedAt: "2026-09-30T10:00:00.000Z",
				},
			}),
			expectView(text(/regressed/)).toExist(),
		)
	})

	test("an alert issue has no window events tile, so no claim about a window it never read", () => {
		scene(
			{ update, view },
			given<Model>({ surge: null, windowCount: 0, history: noHistory, kind: "alert" }),
			expectView(text("Quiet in this window")).not.toExist(),
			expectView(text(/Events ·/)).not.toExist(),
			expectView(text("All time")).toExist(),
		)
	})
})
