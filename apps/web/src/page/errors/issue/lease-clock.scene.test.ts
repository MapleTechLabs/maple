import { OrgId } from "@maple/domain"
import { ErrorIssueId } from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import type { PageContext } from "../../contract"
import { MountRightRail } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, update } from "./update"
import { view as pageView } from "./view"

// `LeaseHud`'s countdown runs on its own once-a-second clock while a lease is held.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const holder = {
	id: encodePublicId("actor", "0199a005-0000-7000-8000-000000000001"),
	type: "agent",
	user_id: null,
	agent_name: "triage-bot",
	model: null,
	capabilities: [],
	last_active_at: null,
}

const detailOf = (isHeld: boolean) =>
	Schema.decodeUnknownSync(V2ErrorIssueDetail)({
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
		severity: null,
		severity_source: null,
		source_ref: null,
		assigned_actor: null,
		lease_holder: isHeld ? holder : null,
		lease_expires_at: isHeld ? "2026-10-01T12:05:00.000Z" : null,
		claimed_at: isHeld ? "2026-10-01T11:50:00.000Z" : null,
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

const loaded = (isHeld: boolean): Model => {
	const windowed = pageUpdate(
		init({ issueId, search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		windowed,
		Message.CompletedFetchDetail({
			key: windowed.detail.key ?? "",
			result: Result.succeed(detailOf(isHeld)),
		}),
	).model
}

describe("error issue lease countdown", () => {
	test("the clock runs only while a lease is held", () => {
		const deps = (model: Model) => subscriptions.leaseClock.modelToDependencies({ model, context })
		expect(deps(loaded(true))).toEqual({ isHeld: true })
		expect(deps(loaded(false))).toEqual({ isHeld: false })
	})

	test("each tick counts the ring down", () => {
		const ticked = pageUpdate(loaded(true), Message.TickedLeaseClock({ nowMs: NOW + 61_000 }))
		scene(
			{ update: pageUpdate, view },
			given({ ...ticked.model, isRightRailMounted: true }),
			Mount.resolve(MountRightRail, Message.MountedRightRail()),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("3:59")).toExist(),
		)
	})
})
