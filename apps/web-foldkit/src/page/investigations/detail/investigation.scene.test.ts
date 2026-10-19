import { OrgId } from "@maple/domain"
import type { V2Investigation } from "@maple/domain/http/v2"
import { InvestigationRowSchema, rowsToInvestigation } from "@maple/web-data/collections/investigations"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { AppRoute } from "../../../route"
import { AttachFlowCanvas } from "../../../service-map/xyflow/attach"
import * as Canvas from "../../../service-map/xyflow/canvas"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const ORG = "org_parity"
const ID = "0199a061-0000-7000-8000-000000000001"
const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

// Matched by name: the canvas Mount is mapped into the page, so it resolves with the lifted Message.
const paned = () =>
	Mount.resolve({ name: AttachFlowCanvas.name }, Message.GotCanvasMessage({ message: Canvas.Message.ResizedPane({ width: 1102, height: 222 }) }))

const NOW = Date.parse("2026-10-01T12:00:00.000Z")

const row = (overrides: Readonly<Record<string, unknown>>) => ({
	id: ID,
	org_id: ORG,
	status: "diagnosed",
	seeded_by: "system",
	subject_json: { type: "incident", incidentKind: "anomaly", incidentId: "0199a060-0000-7000-8000-000000000001" },
	snapshot_json: {
		title: "payment-svc p95 latency above baseline",
		scope: "payment-svc",
		status: "open",
		severity: "critical",
		facts: [],
		references: [],
		incidentStartedAt: "2026-10-01T10:10:00.000Z",
		incidentEndedAt: null,
	},
	report_json: {
		summary: "payment-svc 3.5.0 exhausts its connection pool.",
		suspectedCause: "The rollout halved the pool size.",
		severityAssessment: "critical",
		affectedScope: "POST /charge",
		evidence: [{ traceIds: ["6843a8853182b32339b2dd5120d423f2"], logPatterns: [], relatedServices: ["checkout-api"], note: "Pool wait dominates." }],
		suggestedActions: ["Roll payment-svc back to 3.4.1"],
		confidence: "high",
	},
	progress_json: null,
	severity: "critical",
	confidence: "high",
	model: "maple-triage",
	input_tokens: 10,
	output_tokens: 2,
	error: null,
	created_by: null,
	created_at: "2026-10-01T10:15:00.000Z",
	started_at: "2026-10-01T10:15:00.000Z",
	diagnosed_at: "2026-10-01T10:22:00.000Z",
	updated_at: "2026-10-01T10:22:00.000Z",
	...overrides,
})

const investigationOf = (overrides: Readonly<Record<string, unknown>> = {}): V2Investigation => {
	const decoded = rowsToInvestigation(Schema.decodeUnknownSync(InvestigationRowSchema)(row(overrides)))
	if (decoded === null) return expect.unreachable("fixture row must decode")
	return decoded
}

const entered = (search: Model["search"] = {}) => ({ ...init(AppRoute.Investigation({ id: ID, search }), context).model, nowMs: NOW })
const synced = (model: Model, investigation: V2Investigation) =>
	pageUpdate(model, Message.SyncedInvestigation({ orgId: ORG, id: ID, attempt: 0, sync: { _tag: "Ready", investigation } }))

describe("investigation detail", () => {
	test("entry reads the clock and waits on the live shape", () => {
		const start = init(AppRoute.Investigation({ id: ID, search: {} }), context)
		expect(names(start.commands)).toEqual(["ReadInvestigationClock"])
		expect(start.model.sync._tag).toBe("Loading")
		scene({ update: pageUpdate, view }, given(start.model), expectView(role("img", { name: "Loading the provenance graph" })).toExist())
	})

	test("a malformed id is not found without a request", () => {
		const start = init(AppRoute.Investigation({ id: "not-a-uuid", search: {} }), context)
		scene({ update: pageUpdate, view }, given(start.model), expectView(text("This investigation is unavailable")).toExist())
	})

	test("a lost live connection offers a retry", () => {
		const failed = pageUpdate(entered(), Message.SyncedInvestigation({ orgId: ORG, id: ID, attempt: 0, sync: { _tag: "Failed" } })).model
		scene({ update: pageUpdate, view }, given(failed), expectView(text("This investigation could not be loaded")).toExist())
	})

	test("Try again resubscribes the live shape, and the dropped stream's answer is ignored", () => {
		const failed = pageUpdate(entered(), Message.SyncedInvestigation({ orgId: ORG, id: ID, attempt: 0, sync: { _tag: "Failed" } })).model
		const deps = (model: Model) => subscriptions.investigation.modelToDependencies({ model, context })
		scene(
			{ update: pageUpdate, view },
			given(failed),
			click(role("button", { name: "Try again" })),
			expectView(role("img", { name: "Loading the provenance graph" })).toExist(),
		)
		const retried = pageUpdate(failed, Message.ClickedRetrySync()).model
		expect(deps(retried)).not.toEqual(deps(failed))
		const stale = pageUpdate(retried, Message.SyncedInvestigation({ orgId: ORG, id: ID, attempt: 0, sync: { _tag: "Failed" } }))
		expect(stale.model.sync._tag).toBe("Loading")
	})

	test("a diagnosis renders the verdict and reads the signals card's two series", () => {
		const step = synced(entered(), investigationOf())
		expect(names(step.commands)).toEqual(["FetchInvestigationSignalTraces", "FetchInvestigationSignalLogs"])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			paned(),
			expectView(text("Suspected cause")).toExist(),
			expectView(role("application", { name: "Investigation provenance graph" })).toExist(),
			expectView(role("button", { name: "Resolve" })).toExist(),
		)
	})

	test("the traces row follows the investigation's service over the same window's overview", () => {
		const first = synced(entered(), investigationOf())
		const traces = first.commands?.find((command) => command.name === "FetchInvestigationSignalTraces")
		const key = traces?.args !== undefined && "key" in traces.args ? String(traces.args.key) : ""
		const rows = [
			{ serviceName: "checkout-api", spanCount: 457, p95LatencyMs: 12, errorRate: 0 },
			{ serviceName: "payment-svc", spanCount: 731, p95LatencyMs: 40, errorRate: 0 },
		]
		const loaded = pageUpdate(first.model, Message.CompletedFetchTraces({ key, result: Result.succeed(rows) })).model
		const evidence = [{ traceIds: [], logPatterns: [], relatedServices: ["payment-svc"], note: "Pool wait dominates." }]
		const moved = investigationOf({ report_json: { ...row({}).report_json, evidence } })
		const resynced = synced(loaded, moved)
		expect(names(resynced.commands)).not.toContain("FetchInvestigationSignalTraces")
		scene(
			{ update: pageUpdate, view },
			given(resynced.model),
			paned(),
			expectView(text("731")).toExist(),
			expectView(text("457")).not.toExist(),
		)
	})

	test("the Evidence tab reads no signals and lists the findings", () => {
		const step = synced(entered({ tab: "evidence" }), investigationOf())
		expect(names(step.commands)).toEqual([])
		scene({ update: pageUpdate, view }, given(step.model), expectView(text("Pool wait dominates.")).toExist())
	})

	test("Resolve writes once and toasts", () => {
		const ready = synced(entered(), investigationOf()).model
		const started = pageUpdate(ready, Message.ClickedPrimary())
		expect(names(started.commands)).toEqual(["ResolveInvestigation"])
		expect(pageUpdate(started.model, Message.ClickedPrimary()).commands ?? []).toHaveLength(0)
		const done = pageUpdate(started.model, Message.CompletedResolve({ result: Result.void }))
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Investigation resolved", description: "" }))
		const failed = pageUpdate(started.model, Message.CompletedResolve({ result: Result.fail(toLoadFailure(new Error("down"))) }))
		expect(failed.outMessage?._tag).toBe("RequestedToast")
		expect(failed.model.busy).toBeNull()
	})

	test("a failed run's primary action restarts it", () => {
		const ready = synced(entered(), investigationOf({ status: "failed", report_json: null, diagnosed_at: null })).model
		scene({ update: pageUpdate, view }, given(ready), paned(), expectView(role("button", { name: "Retry" })).toExist())
		expect(names(pageUpdate(ready, Message.ClickedPrimary()).commands)).toEqual(["RestartInvestigation"])
	})

	test("a proposed action opens its panel through the URL, and a stale index opens nothing", () => {
		const ready = synced(entered(), investigationOf()).model
		expect(pageUpdate(ready, Message.ClickedAction({ index: 0 })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: `/investigations/${ID}?action=0`, isReplace: true }),
		)
		const opened = routeChanged(ready, AppRoute.Investigation({ id: ID, search: { action: 0 } }), context).model
		expect(opened.actionSheet.isOpen).toBe(true)
		const stale = routeChanged(ready, AppRoute.Investigation({ id: ID, search: { action: "abc" } }), context).model
		expect(stale.actionSheet.isOpen).toBe(false)
	})

	test("the follow-up composer hands the question to the Chat tab", () => {
		const ready = synced(entered(), investigationOf()).model
		expect(pageUpdate(ready, Message.ClickedFollowUp()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: `/investigations/${ID}?tab=chat`, isReplace: false }),
		)
	})
})
