import { OrgId } from "@maple/domain"
import { AlertCheckDocument, AlertRuleId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import {
	all,
	click,
	Command,
	expect as expectView,
	expectAll,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Chart from "../../../charts/chart"
import { MountChart } from "../../../charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import * as Menu from "../../../ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { destinationRow, incidentRow, NOW, ORG, ruleId, ruleRow, stateRow } from "../shared/test-rows"
import { ToggleRuleEnabled } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const RULE = Schema.decodeSync(AlertRuleId)(ruleId(2))
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const themeResolved = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const route = (search: Model["search"] = {}) => ({ _tag: "AlertRule" as const, ruleId: RULE, search })

const loaded = (search: Model["search"] = {}, rule = ruleRow(2, { name: "Payment p95 latency" })): Model =>
	[
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		Message.ReadDiagnosisClock({ nowMs: NOW }),
		Message.UpdatedRules({ orgId: ORG, rows: [rule] }),
		Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2)] }),
		Message.UpdatedIncidents({ orgId: ORG, rows: [] }),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
	].reduce((model, message) => pageUpdate(model, message).model, init(route(search), context).model)

const totals = { total: 0, breached: 0, healthy: 0, skipped: 0, error: 0, transitions: 0 }
const firstPage = (nextCursor: string) => ({
	checks: [],
	hasMore: true,
	nextCursor,
	summary: { bucketSeconds: 60, totals, points: [] },
})
const withChecks = (model: Model, cursor: string) =>
	pageUpdate(model, Message.CompletedFetchChecks({ key: model.checks.key ?? "", result: Result.succeed(firstPage(cursor)) })).model

describe("alert rule", () => {
	test("load more answers only its own window: a new window's panel starts over with its own cursor", () => {
		const shown = withChecks(loaded(), "cursor-a")
		const loading = pageUpdate(shown, Message.ClickedLoadMoreChecks())
		expect(loading.commands?.[0]?.args).toMatchObject({ cursor: "cursor-a" })
		expect(pageUpdate(loading.model, Message.ClickedLoadMoreChecks()).commands ?? []).toEqual([])
		const nextWindow = { startTime: "2026-09-30 13:00:00", endTime: "2026-10-01 13:00:00" }
		const moved = pageUpdate(loading.model, Message.CompletedResolveWindow({ window: nextWindow, nowMs: NOW, mode: "Load" })).model
		expect(pageUpdate(moved, Message.ClickedLoadMoreChecks()).commands ?? []).toEqual([])
		const generation = loading.commands?.[0]?.args !== undefined && "generation" in loading.commands[0].args ? Number(loading.commands[0].args.generation) : 0
		const late = Message.CompletedLoadMoreChecks({ generation, result: Result.succeed({ checks: [], nextCursor: "cursor-a2" }) })
		const dropped = pageUpdate(moved, late).model
		expect(dropped.nextCursorOverride).toBeUndefined()
		const fresh = withChecks(dropped, "cursor-b")
		expect(pageUpdate(fresh, Message.ClickedLoadMoreChecks()).commands?.[0]?.args).toMatchObject({ cursor: "cursor-b" })
	})

	test("entry resolves the window; the checks and the preview follow the window and the rule", () => {
		const entered = init(route(), context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ResolveAlertRuleWindow", "FetchAlertRuleDeliveries"]),
		)
		const windowed = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(windowed.commands)).toEqual(["FetchAlertRuleChecks"])
		const withRule = pageUpdate(windowed.model, Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }))
		expect(names(withRule.commands)).toEqual(
			expect.arrayContaining(["FetchAlertRulePreview", "ReadAlertRuleDiagnosisClock"]),
		)
	})

	test("a failed checks read shows its error and is not refetched by a live row change", () => {
		const model = loaded()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchChecks({ key: model.checks.key ?? "", result: Result.fail(toLoadFailure(new Error("x"))) }),
		).model
		expect(
			names(pageUpdate(failed, Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] })).commands),
		).not.toContain("FetchAlertRuleChecks")
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Failed to load checks")).toExist(),
		)
	})

	test("the Overview and History tab links keep the time range", () => {
		const search = { timePreset: "7d" }
		const href = (tab: string) => `/alerts/${RULE}?tab=${tab}&timePreset=7d`
		scene(
			{ update: pageUpdate, view },
			given(loaded(search)),
			themeResolved(),
			expectView(role("link", { name: "History" })).toHaveAttr("href", href("history")),
			expectView(role("link", { name: "Overview" })).toHaveAttr("href", href("overview")),
		)
	})

	test("after a Reload a tab change keeps the window; a new preset re-resolves unsnapped", () => {
		const reloaded = pageUpdate(loaded(), Message.ClickedReload()).model
		const tabbed = routeChanged(reloaded, route({ tab: "history" }), context)
		expect(tabbed.commands ?? []).toEqual([])
		expect(tabbed.model.search).toEqual({ tab: "history" })
		const moved = routeChanged(tabbed.model, route({ tab: "history", timePreset: "1h" }), context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveAlertRuleWindow", "Refresh"]])
	})

	test("an unknown rule says so", () => {
		const model = pageUpdate(init(route(), context).model, Message.UpdatedRules({ orgId: ORG, rows: [] })).model
		scene({ update: pageUpdate, view }, given(model), themeResolved(), expectView(text("Rule not found")).toExist())
	})

	test("a raw SQL rule slowed down by its timeouts shows its query time per check and why", () => {
		const check = (minutesAgo: number, durationMs: number, status: "healthy" | "error") =>
			Schema.decodeUnknownSync(AlertCheckDocument)({
				timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
				groupKey: "__total__",
				status,
				skipReason: null,
				signalType: "raw_query",
				comparator: "gt",
				threshold: 10,
				thresholdUpper: null,
				observedValue: status === "error" ? null : 3,
				sampleCount: status === "error" ? 0 : 3,
				windowMinutes: 5,
				windowStart: new Date(NOW - (minutesAgo + 5) * 60_000).toISOString(),
				windowEnd: new Date(NOW - minutesAgo * 60_000).toISOString(),
				consecutiveBreaches: 0,
				consecutiveHealthy: 1,
				incidentId: null,
				incidentTransition: "none",
				level: null,
				evaluationDurationMs: durationMs,
				errorMessage: status === "error" ? "Timeout exceeded: elapsed 5003 ms" : null,
				errorCategory: status === "error" ? "warehouse_quota_exceeded" : null,
			})
		const rule = ruleRow(2, {
			signal_type: "raw_query",
			service_names_json: [],
			environments_json: [],
			raw_query_sql: "SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
			slowed_interval_minutes: 5,
			slowed_at: new Date(NOW - 30 * 60_000).toISOString(),
		})
		const model = loaded({}, rule)
		const withSlowChecks = pageUpdate(
			model,
			Message.CompletedFetchChecks({
				key: model.checks.key ?? "",
				result: Result.succeed({
					...firstPage("next"),
					checks: [check(5, 7_800, "healthy"), check(35, 5_003, "error"), check(36, 5_004, "error")],
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withSlowChecks),
			themeResolved(),
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("Query time per check")).toExist(),
			expectView(text("Slowest 7.8 s · limit 15 s at every 5 min")).toExist(),
			expectAll(all.selector('[data-testid="query-time-bars"] [title]')).toHaveCount(3),
			expectView(text("Slowed to every 5 min because its query kept hitting its limit")).toExist(),
		)
	})

	test("a disabled rule's diagnosis offers Enable, which PATCHes the rule once", () => {
		const model = loaded({}, ruleRow(2, { enabled: false }))
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			click(role("button", { name: "Enable rule" })),
			Command.resolve(ToggleRuleEnabled, Message.CompletedToggleEnabled({ result: Result.succeed(undefined) })),
		)
		const toggling = pageUpdate(model, Message.ClickedToggleEnabled())
		expect(names(toggling.commands)).toEqual(["ToggleAlertRuleEnabled"])
		expect(pageUpdate(toggling.model, Message.ClickedToggleEnabled()).commands ?? []).toHaveLength(0)
	})

	test("a rail bucket fetches only its own checks and drops an answer for an older pick", () => {
		const model = loaded()
		const first = pageUpdate(model, Message.ClickedRailBucket({ index: 3 }))
		expect(names(first.commands)).toEqual(["FetchAlertRuleBucketChecks"])
		const second = pageUpdate(first.model, Message.ClickedRailBucket({ index: 4 })).model
		const stale = pageUpdate(second, Message.CompletedFetchBucketChecks({ request: first.model.bucketRequest, result: Result.succeed([]) }))
		expect(stale.model.isBucketLoading).toBe(true)
		expect(pageUpdate(second, Message.ClickedClearBucket()).model.selectedBucket).toBeNull()
	})

	test("the History filter and the incident menu", () => {
		const withIncident = pageUpdate(loaded({ tab: "history" }), Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] })).model
		scene(
			{ update: pageUpdate, view },
			given(withIncident),
			themeResolved(),
			expectView(text("1 total triggers")).toExist(),
			click(role("button", { name: "Resolved" })),
			expectView(text("No incidents")).toExist(),
		)
		const viewAll = pageUpdate(withIncident, Message.GotRowMenuMessage({
			menuId: `incident:${incidentRow().id}`,
			message: Menu.Message.ClickedItem({ index: 1, item: { kind: "Item", value: "all" } }),
		}))
		expect(viewAll.outMessage).toEqual(PageOutMessage.RequestedNavigation({ url: "/alerts?tab=overview", isReplace: false }))
	})
})
