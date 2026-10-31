import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2AnomalyIncident } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	label,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { MeasureTabIndicator, Message as TabsMessage } from "../../../ui/tabs"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { type PageContext, PageOutMessage } from "../../contract"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { allIncidentsOf } from "./derive"
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
	Mount.resolve(
		MeasureTabIndicator,
		TabsMessage.MeasuredIndicator({
			rect: { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 },
		}),
	)
const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status, lastSeenMs: null } }),
		}),
	).model
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
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining([
				"LoadAnomaliesSignalPresence",
				"ReadAnomaliesClock",
				"FetchAnomalyIncidents",
				"ReadRememberedFilterSections",
			]),
		)
	})

	test("a stale answer is dropped; a failure renders the error state", () => {
		const entered = init({ search: {} }, context).model
		expect(pageUpdate(entered, Message.CompletedFetchFirstPage({ key: "other", result: Result.succeed({ data: [], nextCursor: null }) })).model.firstPage).toEqual(entered.firstPage)
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchFirstPage({ key: entered.firstPage.key ?? "", result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		scene({ update: pageUpdate, view }, given(failed), measured(), expectView(text("Couldn't load anomalies")).toExist())
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
			click(role("button", { name: "Live" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ url: "/anomalies?live=false", isReplace: false })),
		)
		const switched = routeChanged(model, { search: { status: "all" } }, context)
		expect(names(switched.commands)).toEqual(["FetchAnomalyIncidents"])
		expect(switched.model.firstPage.data._tag).toBe("Refreshing")
	})

	test("an empty list shows a skeleton until presence is known, then setup or the quiet copy", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			measured(),
			expectView(text("No open anomalies")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded([]), "absent")),
			measured(),
			expectView(text("No open anomalies")).toExist(),
			expectView(role("link", { name: "Set up tracing" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded([]), "present")),
			measured(),
			expectView(role("link", { name: "Create an alert rule" })).toExist(),
		)
	})

	test("a live tick reads the clock, so a quiet open row turns stale", () => {
		const model = loaded([incident(1, "critical")])
		const ticked = pageUpdate(model, Message.TickedLiveRefresh({ nowMs: NOW + 3 * 3_600_000 })).model
		scene(
			{ update: pageUpdate, view },
			given(ticked),
			measured(),
			expectView(text(`last seen ${formatRelativeTime(NOW - 60_000, NOW + 3 * 3_600_000)}`)).toExist(),
		)
	})

	test("during a tab switch Load more waits for the new tab's first page and drops the old tab's cursor", () => {
		const entered = init({ search: {} }, context).model
		const open = pageUpdate(
			entered,
			Message.CompletedFetchFirstPage({
				key: entered.firstPage.key ?? "",
				result: Result.succeed({ data: [incident(1, "critical")], nextCursor: "c1" }),
			}),
		).model
		const switched = routeChanged(open, { search: { status: "all" } }, context).model
		expect(pageUpdate(switched, Message.ClickedLoadMore()).commands ?? []).toHaveLength(0)
		const mixed = pageUpdate(
			switched,
			Message.CompletedLoadMore({
				status: "all",
				cursor: "c1",
				result: Result.succeed({ data: [incident(2, "critical")], nextCursor: null }),
			}),
		).model
		expect(allIncidentsOf(mixed).map((row) => row.id.slice(-1))).toEqual(["1"])
		const landed = pageUpdate(
			mixed,
			Message.CompletedFetchFirstPage({
				key: switched.firstPage.key ?? "",
				result: Result.succeed({ data: [incident(3, "critical")], nextCursor: "a1" }),
			}),
		).model
		expect(names(pageUpdate(landed, Message.ClickedLoadMore()).commands)).toEqual(["LoadMoreAnomalyIncidents"])
	})

	test("a load-more answer for a cursor a live tick discarded is dropped", () => {
		const entered = init({ search: {} }, context).model
		const first = (rows: ReadonlyArray<V2AnomalyIncident>) =>
			Message.CompletedFetchFirstPage({ key: entered.firstPage.key ?? "", result: Result.succeed({ data: rows, nextCursor: "c1" }) })
		const model = [
			first([incident(1, "critical")]),
			Message.CompletedLoadMore({ status: "open", cursor: "c1", result: Result.succeed({ data: [incident(2, "critical")], nextCursor: "c2" }) }),
			Message.TickedLiveRefresh({ nowMs: NOW }),
			first([incident(1, "critical")]),
			Message.CompletedLoadMore({ status: "open", cursor: "c2", result: Result.succeed({ data: [incident(3, "critical")], nextCursor: null }) }),
		].reduce((next, message) => pageUpdate(next, message).model, entered)
		expect(allIncidentsOf(model).map((row) => row.id.slice(-1))).toEqual(["1"])
		expect(model.isLoadingMore).toBe(false)
	})
})
