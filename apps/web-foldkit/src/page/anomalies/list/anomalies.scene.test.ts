import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2AnomalyIncident } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, Command, expect as expectView, expectOutMessage, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { MeasureTabIndicator, Message as TabsMessage } from "../../../ui/tabs"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { type PageContext, PageOutMessage } from "../../contract"
import { LoadSignalPresence, MountBody } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const NOW = Date.UTC(2026, 9, 1, 12)
const measured = () =>
	Mount.resolve(MeasureTabIndicator, TabsMessage.MeasuredIndicator({ rect: { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 } }))
const painted = () => [
	Mount.resolve(MountBody, Message.PaintedBody()),
	Command.resolve(LoadSignalPresence, Message.CompletedLoadSignalPresence({ result: Result.succeed({}) })),
]
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString()

const incident = (index: number, severity: "critical" | "warning", resolved = false) =>
	Schema.decodeUnknownSync(V2AnomalyIncident)({
		id: encodePublicId(PublicIdPrefixes.anomalyIncident, `0199a060-0000-7000-8000-00000000000${index}`),
		object: "anomaly_incident",
		detector_key: `latency_p95:payment-svc:production`,
		signal_type: "latency_p95",
		service_name: "payment-svc",
		deployment_env: "production",
		fingerprint_hash: null,
		error_issue_id: null,
		status: resolved ? "resolved" : "open",
		severity,
		opened_value: 1000,
		baseline_median: 400,
		baseline_sigma: 100,
		threshold_value: 800,
		last_observed_value: 1800,
		last_sample_count: 100,
		first_triggered_at: iso(60 * 60_000),
		last_triggered_at: iso(60_000),
		resolved_at: resolved ? iso(30_000) : null,
		resolve_reason: resolved ? "returned_to_baseline" : null,
		triage_status: "none",
		fingerprints: [],
		reopen_count: 0,
		last_reopened_at: null,
	})

const loaded = (rows: ReadonlyArray<V2AnomalyIncident>, search = {}) => {
	const entered = init({ search }, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchFirstPage({ key: entered.firstPage.key ?? "", result: Result.succeed({ data: rows, nextCursor: null }) }),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("anomalies list", () => {
	test("entry reads the clock, the open incidents and the remembered filter sections", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual([
			"ReadAnomaliesClock",
			"FetchAnomalyIncidents",
			"ReadRememberedFilterSections",
		])
	})

	test("a stale answer is dropped; a failure renders the error state", () => {
		const entered = init({ search: {} }, context).model
		expect(pageUpdate(entered, Message.CompletedFetchFirstPage({ key: "other", result: Result.succeed({ data: [], nextCursor: null }) })).model.firstPage).toEqual(entered.firstPage)
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchFirstPage({ key: entered.firstPage.key ?? "", result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		scene({ update: pageUpdate, view }, given(failed), measured(), expectView(text("Failed to load anomalies")).toExist())
	})

	test("j and k walk the rows in group order, Enter opens the focused one, Escape clears it", () => {
		const model = loaded([incident(2, "warning"), incident(1, "critical")])
		const first = pageUpdate(model, Message.PressedListKey({ key: "Next" }))
		expect(first.model.focusedId).toContain("00000000001")
		expect(names(first.commands)).toEqual(["ScrollAnomalyIncidentIntoView"])
		const second = pageUpdate(first.model, Message.PressedListKey({ key: "Next" })).model
		expect(second.focusedId).not.toBe(first.model.focusedId)
		expect(pageUpdate(second, Message.PressedListKey({ key: "Previous" })).model.focusedId).toBe(first.model.focusedId)
		const opened = pageUpdate(second, Message.PressedListKey({ key: "Open" }))
		expect(opened.outMessage?._tag).toBe("RequestedNavigation")
		expect(pageUpdate(second, Message.PressedListKey({ key: "Escape" })).model.focusedId).toBeNull()
	})

	test("rows group by severity and a group collapses", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([incident(1, "critical"), incident(2, "warning")])),
			measured(),
			...painted(),
			expectView(text("2 anomalies")).toExist(),
			click(role("button", { name: /^Critical/ })),
			expectView(role("button", { name: /^Critical/ })).toHaveAttr("aria-expanded", "false"),
		)
	})

	test("the Live chip pauses through the URL; a tab switch keeps the rows while it loads", () => {
		const model = loaded([incident(1, "critical")])
		scene(
			{ update: pageUpdate, view },
			given(model),
			measured(),
			...painted(),
			click(role("button", { name: "Live" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ url: "/anomalies?live=false", isReplace: false })),
		)
		const switched = routeChanged(model, { search: { status: "all" } }, context)
		expect(names(switched.commands)).toEqual(["FetchAnomalyIncidents"])
		expect(switched.model.firstPage.data._tag).toBe("Refreshing")
	})

	test("an empty org asks for presence once the body paints", () => {
		const model = loaded([])
		const afterPaint = pageUpdate(model, Message.PaintedBody())
		expect(names(afterPaint.commands)).toEqual(["LoadAnomaliesSignalPresence"])
		expect(pageUpdate(afterPaint.model, Message.PaintedBody()).commands ?? []).toHaveLength(0)
		scene(
			{ update: pageUpdate, view },
			given(model),
			measured(),
			...painted(),
			expectView(text("No open anomalies")).toExist(),
		)
	})
})
