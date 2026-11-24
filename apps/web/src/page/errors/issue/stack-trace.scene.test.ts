import { OrgId } from "@maple/domain"
import type { SymbolicatedStack } from "@maple/domain/errors/js-stack"
import { ErrorIssueId } from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { click, expect as expectView, given, role, scene, selector, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { detailOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { exceptionPanel } from "./view-overview"

// The exception panel's stack: mapped frames when a source map matched, the raw text otherwise.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.UTC(2026, 9, 1, 12)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const RAW = "TypeError: x is undefined\n    at Kc (https://app.acme.dev/assets/index-Bx81.js:1:48213)"

const frame = (
	fields: Partial<SymbolicatedStack["frames"][number]> & { function: string },
): SymbolicatedStack["frames"][number] => ({
	raw: `at ${fields.function}`,
	file: "src/billing/plan.ts",
	line: 10,
	column: 3,
	in_app: true,
	resolved: true,
	context: null,
	...fields,
})

const resolved: SymbolicatedStack = {
	status: "resolved",
	frames: [
		frame({
			function: "resolvePlan",
			context: { pre: ["const tier = account.tier"], line: "return catalog[tier].plan", post: ["}"] },
		}),
		frame({ function: "dispatch", file: "node_modules/hono/dist/compose.js", in_app: false }),
		frame({ function: "handle", file: "node_modules/hono/dist/handle.js", in_app: false }),
		frame({
			function: "handleRenewal",
			file: "src/routes/renewals.ts",
			context: { pre: [], line: "await subscriptions.renew(id)", post: [] },
		}),
	],
	missing: [],
}

const missingMap: SymbolicatedStack = {
	status: "missing_map",
	frames: [],
	missing: ["https://app.acme.dev/assets/index-Bx81.js"],
}

const wireWith = (stack: SymbolicatedStack | null, raw: string) =>
	Schema.decodeSync(V2ErrorIssueDetail)({
		id: encodePublicId("iss", issueId),
		object: "error_issue",
		kind: "error",
		fingerprint_hash: "1",
		service_name: "web",
		exception_type: "TypeError",
		exception_message: "x is undefined",
		error_label: "TypeError",
		top_frame: "at Kc (index-Bx81.js:1:48213)",
		workflow_state: "triage",
		priority: 1,
		severity: null,
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
		latest_stacktrace: raw,
		latest_stack: stack,
	})

const delivered = (model: Model, stack: SymbolicatedStack | null, raw: string): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchDetail({
			key: model.detail.key ?? "",
			result: Result.succeed(wireWith(stack, raw)),
		}),
	).model

const loadedWith = (stack: SymbolicatedStack | null, raw: string = RAW): Model =>
	delivered(
		pageUpdate(
			init({ issueId, search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model,
		stack,
		raw,
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	Option.match(detailOf(model), {
		onNone: () => h.div([], []),
		onSome: (detail) =>
			exceptionPanel(h, model, detail.issue, detail.latestStacktrace, detail.latestStack),
	})

describe("issue stack trace", () => {
	test("a mapped stack opens on the top app frame's code, with library frames folded", () => {
		scene(
			{ update: pageUpdate, view },
			given(loadedWith(resolved)),
			expectView(text("Source mapped")).toExist(),
			expectView(selector("#issue-stack-frame-0 [data-error-line]")).toExist(),
			expectView(text("dispatch")).toBeAbsent(),
			click(role("button", { name: "2 library frames" })),
			expectView(text("dispatch")).toExist(),
			expectView(selector("#issue-stack-frame-3")).toBeAbsent(),
			click(role("button", { name: /handleRenewal/ })),
			expectView(selector("#issue-stack-frame-3 [data-error-line]")).toExist(),
		)
	})

	test("Raw swaps the frames for the text the SDK sent, and back", () => {
		scene(
			{ update: pageUpdate, view },
			given(loadedWith(resolved)),
			expectView(text(/assets\/index-Bx81\.js:1:48213/)).toBeAbsent(),
			click(role("button", { name: "Raw" })),
			expectView(text(/assets\/index-Bx81\.js:1:48213/)).toExist(),
			expectView(text("resolvePlan")).toBeAbsent(),
			click(role("button", { name: "Raw" })),
			expectView(text("resolvePlan")).toExist(),
		)
	})

	test("a stack with no map keeps the raw text and names the file to upload a map for", () => {
		scene(
			{ update: pageUpdate, view },
			given(loadedWith(missingMap)),
			expectView(
				text(/Could not map https:\/\/app\.acme\.dev\/assets\/index-Bx81\.js to source/),
			).toExist(),
			expectView(text("maple sourcemaps upload")).toExist(),
			expectView(text("Full stack trace")).toExist(),
			expectView(text("Source mapped")).toBeAbsent(),
		)
	})

	test("a partly mapped stack lists the files that did not map, in the page rather than a tooltip", () => {
		const partial: SymbolicatedStack = {
			...resolved,
			status: "partial",
			missing: ["https://app.acme.dev/assets/vendor-9f.js"],
		}
		scene(
			{ update: pageUpdate, view },
			given(loadedWith(partial)),
			expectView(text("Partly source mapped")).toExist(),
			expectView(text("Not mapped to source: https://app.acme.dev/assets/vendor-9f.js")).toExist(),
		)
	})

	test("Raised at keeps the reported frame when the top app frame did not map", () => {
		const topUnmapped: SymbolicatedStack = {
			...resolved,
			status: "partial",
			frames: [
				frame({ function: "Kc", file: "https://app.acme.dev/assets/index-Bx81.js", resolved: false }),
				...resolved.frames,
			],
			missing: ["https://app.acme.dev/assets/index-Bx81.js"],
		}
		scene(
			{ update: pageUpdate, view },
			given(loadedWith(topUnmapped)),
			expectView(text("at Kc (index-Bx81.js:1:48213)")).toExist(),
			expectView(text(/resolvePlan \(src\/billing\/plan\.ts/)).toBeAbsent(),
		)
	})

	test("a different stack arriving resets the rows the reader flipped", () => {
		const flipped = pageUpdate(loadedWith(resolved), Message.ToggledStackRow({ key: "frame-3" })).model
		const raw = pageUpdate(flipped, Message.ToggledRawStack()).model
		const same = delivered(raw, resolved, RAW)
		const next = delivered(
			raw,
			resolved,
			`${RAW}\n    at Zt (https://app.acme.dev/assets/index-Qz07.js:1:9)`,
		)
		expect([same.stackToggles, same.isShowingRawStack]).toEqual([["frame-3"], true])
		expect([next.stackToggles, next.isShowingRawStack]).toEqual([[], false])
		const remapped = delivered(raw, { ...resolved, status: "partial" }, RAW)
		expect([remapped.stackToggles, remapped.isShowingRawStack]).toEqual([[], false])
	})

	test("an API with no symbolicated stack shows the raw disclosure as before", () => {
		scene(
			{ update: pageUpdate, view },
			given(loadedWith(null)),
			expectView(text("Full stack trace")).toExist(),
			expectView(text(/Could not map/)).toBeAbsent(),
			expectView(role("button", { name: "Raw" })).toBeAbsent(),
		)
	})
})
