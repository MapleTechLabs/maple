import { OrgId } from "@maple/domain"
import { AlertRulePreviewResponse, DashboardDocument } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, V2ChatConnector } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import * as Animation from "@foldkit/ui/animation"
import {
	all,
	click,
	Command,
	expect as expectView,
	expectAll,
	given,
	hover,
	Mount,
	placeholder,
	role,
	scene,
	selector,
	Subscription,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { Lazy } from "foldkit/test"
import { describe, expect, test } from "vitest"
import * as Chart from "../../../charts/chart"
import { MountChart } from "../../../charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import * as Menu from "../../../ui/menu"
import * as RadioGroup from "../../../ui/radio-group"
import * as Tooltip from "../../../ui/tooltip"
import type { PageContext } from "../../contract"
import { destinationRow, NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
import { FetchEditorPreview, ReloadPage } from "./command"
import { init } from "./init"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const DRAFT_ID = "6f1c2e3a-0000-4000-8000-000000000001"
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const route = (search: Model["search"] = {}) => ({ _tag: "AlertsCreate" as const, search })
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)
const entered = (search: Model["search"] = {}) =>
	run(init(route(search), context).model, [
		Message.GeneratedDraftId({ id: DRAFT_ID }),
		Message.CompletedReadClock({ nowMs: NOW }),
	])
const withLists = (model: Model) =>
	run(model, [
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { name: "Payment p95 latency" })] }),
	])

const dashboardFixture = {
	id: "dash-1",
	name: "Checkout",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		{
			id: "w-1",
			visualization: "stat",
			dataSource: { kind: "route", endpoint: "errors_summary" },
			display: { title: "Checkout latency", unit: "number" },
			layout: { x: 0, y: 0, w: 3, h: 2 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
}

describe("alert rule editor", () => {
	test("a new rule opens on the template picker, in the query builder, with the reads it needs", () => {
		const start = init(route(), context)
		expect(names(start.commands)).toEqual(
			expect.arrayContaining([
				"GenerateAlertDraftId",
				"ReadAlertEditorClock",
				"ReadAlertEditorIsAdmin",
				"FetchAlertEditorConnectors",
			]),
		)
		const drafted = pageUpdate(start.model, Message.GeneratedDraftId({ id: DRAFT_ID }))
		expect(drafted.model.form?.signalType).toBe("builder_query")
		expect(drafted.model.form?.queryBuilderDraft.id).toBe(DRAFT_ID)
		expect(drafted.model.templates.isOpen).toBe(true)
		const clocked = pageUpdate(drafted.model, Message.CompletedReadClock({ nowMs: NOW }))
		expect(names(clocked.commands)).toContain("FetchAlertEditorPreview")
		expect(
			names(clocked.commands).filter((name) => name === "FetchAlertEditorAutocomplete"),
		).toHaveLength(6)
		expect(names(clocked.commands)).toContain("FetchAlertEditorTraceFacets")
	})

	test("editing waits for the rules, then opens on the saved rule without a default destination", () => {
		const waiting = entered({ ruleId: ruleId(2) })
		expect(waiting.form).toBeNull()
		const ready = withLists(waiting)
		expect(ready.form?.name).toBe("Payment p95 latency")
		expect(ready.savedForm).toEqual(ready.form)
		expect(ready.editingRuleId).toBe(ruleId(2))
		scene(
			{ update: pageUpdate, view },
			given(ready),
			themeResolved(),
			expectView(text("Save changes")).toExist(),
		)
	})

	test("the severity radios each keep their own hidden input, so the field label names neither", () => {
		const draft = withLists(entered({ template: "slow_p95" }))
		scene(
			{ update: pageUpdate, view },
			given(draft),
			themeResolved(),
			expectAll(all.role("radio", { name: "Warning" })).toHaveCount(1),
			expectAll(all.selector("#rule-severity-input")).toHaveCount(0),
		)
	})

	test("the window hint says how often the window is checked, beside the saved value while editing", () => {
		const hint = (every: string) => text(`Each check looks at this much data, checked every ${every}.`)
		const draft = withLists(entered({ template: "slow_p95" }))
		const withWindow = (model: Model, value: string) =>
			run(model, [Message.ChangedField({ field: "windowMinutes", value })])
		scene(
			{ update: pageUpdate, view },
			given(withWindow(draft, "5")),
			themeResolved(),
			expectView(hint("minute")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withWindow(draft, "15")),
			themeResolved(),
			expectView(hint("3 min")).toExist(),
		)
		const editing = withLists(entered({ ruleId: ruleId(2) }))
		const saved = editing.savedForm?.windowMinutes ?? ""
		expect(saved).not.toBe("60")
		scene(
			{ update: pageUpdate, view },
			given(withWindow(editing, "60")),
			themeResolved(),
			expectView(text(`${saved} min`)).toExist(),
			expectView(hint("5 min")).toExist(),
		)
	})

	test("the check interval picker sets how often the rule runs, and refuses one longer than the window", () => {
		const hint = (every: string) => text(`Each check looks at this much data, checked every ${every}.`)
		const pick = (value: string) =>
			Message.GotRadioMessage({ group: "interval", message: RadioGroup.Message.SelectedRadio({ value }) })
		const draft = run(withLists(entered({ template: "slow_p95" })), [
			Message.ChangedField({ field: "windowMinutes", value: "15" }),
		])
		const every10 = run(draft, [pick("10")])
		const every30 = run(every10, [pick("30")])
		scene(
			{ update: pageUpdate, view },
			given(draft),
			themeResolved(),
			expectView(role("radio", { name: /^Auto · 3 min/ })).toHaveAttr("aria-checked", "true"),
			// The preview pins the interval, so picking one never re-queries.
			click(role("radio", { name: /^10 min/ })),
			expectView(hint("10 min")).toExist(),
			expectView(role("radio", { name: /^10 min/ })).toHaveAttr("aria-checked", "true"),
			click(role("radio", { name: /^30 min/ })),
			expectView(text("Longer than the window, so data between checks would go unread.")).toExist(),
		)
		expect(every10.preview.key).toBe(draft.preview.key)
		expect(every30.form?.evaluationIntervalMinutes).toBe("30")
		expect(names(pageUpdate(every30, Message.ClickedSave()).commands)).toEqual([])
	})

	test("a raw SQL query too slow for its interval says so, blocks save, and switches in one click", () => {
		const timing = (elapsedMs: number) =>
			Schema.decodeUnknownSync(AlertRulePreviewResponse)({
				bucketSeconds: 300,
				windowMinutes: 5,
				threshold: 5,
				thresholdUpper: null,
				thresholds: [{ severity: "warning", value: 5, upper: null, recoveryValue: null, destinationIds: [] }],
				comparator: "gt",
				truncatedToStart: null,
				series: [],
				wouldFire: [],
				queryTiming: {
					elapsedMs,
					failure: null,
					probeLimitMs: 25_000,
					intervalMinutes: 1,
					limitMs: 5_000,
					fitsIntervalMinutes: elapsedMs <= 4_000 ? [1, 5, 10, 15, 30, 60] : [5, 10, 15, 30, 60],
				},
			})
		const answer = (model: Model, elapsedMs: number) =>
			Message.CompletedFetchPreview({
				key: model.preview.key ?? "",
				isSaved: false,
				result: Result.succeed(timing(elapsedMs)),
			})
		const sql = run(withLists(entered({ template: "slow_p95" })), [
			Message.ClickedSignalKind({ kind: "raw_query" }),
		])
		const slow = run(sql, [answer(sql, 7_800)])
		expect(names(pageUpdate(slow, Message.ClickedSave()).commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(slow),
			themeResolved(),
			expectView(text("Too slow for 1-minute checks, fits 5-minute checks.")).toExist(),
			expectView(text(/^Line 4: Filter traces on a service/)).toExist(),
			click(role("button", { name: "Check every 5 min" })),
			expectView(role("radio", { name: /^5 min/ })).toHaveAttr("aria-checked", "true"),
			expectView(text("Fits checks every 5 min.")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(run(sql, [answer(sql, 900)])),
			themeResolved(),
			expectView(text("Fits checks every minute.")).toExist(),
			// A fast query keeps its cheaper-filter suggestions to itself.
			expectView(text(/^Line 4:/)).not.toExist(),
		)
		const heavy = Schema.decodeUnknownSync(AlertRulePreviewResponse)({
			...Schema.encodeSync(AlertRulePreviewResponse)(timing(7_800)),
			seriesFailure: "query_too_slow",
		})
		scene(
			{ update: pageUpdate, view },
			given(
				run(sql, [
					Message.CompletedLoadChartRuntime(),
					Message.CompletedFetchPreview({ key: sql.preview.key ?? "", isSaved: false, result: Result.succeed(heavy) }),
				]),
			),
			themeResolved(),
			// Too heavy to chart, yet the one-check timing still says which interval fits.
			expectView(text(/ran past 25 s charting this range/)).toExist(),
			expectView(text("Too slow for 1-minute checks, fits 5-minute checks.")).toExist(),
		)
		const timed = Schema.encodeSync(AlertRulePreviewResponse)(timing(0))
		const outOfMemory = Schema.decodeUnknownSync(AlertRulePreviewResponse)({
			...timed,
			queryTiming: { ...timed.queryTiming, elapsedMs: null, failure: "query_too_much_memory", fitsIntervalMinutes: [] },
		})
		scene(
			{ update: pageUpdate, view },
			given(
				run(sql, [
					Message.CompletedFetchPreview({ key: sql.preview.key ?? "", isSaved: false, result: Result.succeed(outOfMemory) }),
				]),
			),
			themeResolved(),
			// Out of memory is no verdict on time: no interval reads as too slow.
			expectView(text("It ran out of memory with the most any interval allows, so checking less often will not help.")).toExist(),
			expectView(role("radio", { name: /too slow/ })).not.toExist(),
		)
	})

	test("editing a slowed-down rule says saving resets it, and keeps it in one click", () => {
		const slowed = run(entered({ ruleId: ruleId(2) }), [
			Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { slowed_interval_minutes: 5 })] }),
		])
		const notice = text("Checked every 5 min because its query kept hitting its limit. Saving resets this unless you keep it.")
		scene(
			{ update: pageUpdate, view },
			given(slowed),
			themeResolved(),
			expectView(notice).toExist(),
			click(role("button", { name: "Keep 5 min" })),
			expectView(notice).not.toExist(),
			expectView(role("radio", { name: /^5 min/ })).toHaveAttr("aria-checked", "true"),
		)
	})

	test("a new rule starts on the destination the org's rules use", () => {
		const ready = withLists(entered({ template: "slow_p95" }))
		expect(ready.form?.destinationIds).toEqual([destinationRow().id])
		expect(ready.form?.name).toBe("Slow P95 latency")
	})

	test("a preview answer for an older draft is dropped", () => {
		const model = entered({ template: "slow_p95" })
		const staleKey = model.preview.key ?? ""
		const edited = pageUpdate(model, Message.ChangedField({ field: "threshold", value: "1500" })).model
		expect(edited.preview.key).not.toBe(staleKey)
		const late = pageUpdate(
			edited,
			Message.CompletedFetchPreview({
				key: staleKey,
				isSaved: false,
				result: Result.fail({ message: "late" }),
			}),
		).model
		expect(late.preview).toEqual(edited.preview)
	})

	test("save sends once when ready, and lands on /alerts with a toast", () => {
		const ready = withLists(entered({ template: "slow_p95" }))
		const saving = pageUpdate(ready, Message.ClickedSave())
		expect(names(saving.commands)).toEqual(["SaveAlertRule"])
		expect(names(pageUpdate(saving.model, Message.ClickedSave()).commands)).toEqual([])
		const saved = pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(undefined) }))
		expect(saved.outMessage?._tag).toBe("RequestedNavigation")
	})

	test("a created rule records alert_rule_created with its signal; a failed save does not", () => {
		const saving = pageUpdate(withLists(entered({ template: "slow_p95" })), Message.ClickedSave()).model
		const saved = pageUpdate(saving, Message.CompletedSave({ result: Result.succeed(undefined) }))
		expect(names(saved.commands)).toEqual(["TrackAlertRuleCreated"])
		const failed = pageUpdate(
			saving,
			Message.CompletedSave({ result: Result.fail({ title: "Bad", message: "nope" }) }),
		)
		expect(names(failed.commands)).toEqual([])
	})

	test("past three missing fields, details lists every one", () => {
		const model = run(withLists(entered({ template: "slow_p95" })), [
			Message.ChangedField({ field: "name", value: "" }),
			Message.ChangedField({ field: "threshold", value: "" }),
			Message.ChangedField({ field: "windowMinutes", value: "" }),
			Message.ChangedField({ field: "consecutiveBreachesRequired", value: "" }),
		])
		const details = role("button", { name: "details" })
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("• Checks to fire")).not.toExist(),
			hover(details),
			Command.resolve(Tooltip.WaitOpenDelay, Tooltip.Message.ElapsedOpenDelay({ generation: 1 })),
			Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expectView(text("• Checks to fire")).toExist(),
		)
	})

	test("an edit whose rules sync gave up says so, with a reload, instead of a skeleton", () => {
		const waiting = entered({ ruleId: ruleId(2) })
		const failed = pageUpdate(waiting, Message.FailedLoadRules({ orgId: ORG })).model
		expect(failed.form).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Failed to load alert rules")).toExist(),
			click(role("button", { name: "Try again" })),
			Command.expectHas(ReloadPage()),
			Command.resolve(ReloadPage, Message.ReloadedPage()),
		)
		const answered = pageUpdate(withLists(waiting), Message.FailedLoadRules({ orgId: ORG })).model
		expect(answered.editingRuleId).toBe(ruleId(2))
	})

	test("a widget link without its snapshot prefills from the dashboard, or says it could not load", () => {
		const search = { dashboardId: "dash-1", widgetId: "w-1" }
		expect(withLists(entered(search)).form).toBeNull()
		const dashboard = Schema.decodeUnknownSync(DashboardDocument)(dashboardFixture)
		const found = pageUpdate(
			withLists(entered(search)),
			Message.UpdatedSourceDashboard({ orgId: ORG, dashboards: [dashboard] }),
		).model
		expect(found.draftKey).toBe("dashboard:dash-1:widget:w-1")
		expect(found.notices.map((notice) => notice.message)).not.toContain(
			"The source chart could not be found. Starting from a blank alert.",
		)
		const failed = pageUpdate(
			withLists(entered(search)),
			Message.FailedLoadDashboards({ orgId: ORG }),
		).model
		expect(failed.notices).toEqual([
			{ severity: "warning", message: "Dashboards could not be loaded. Starting from a blank alert." },
		])
	})

	test("Connect in the add destination menu links Slack in a popup, then opens its destination form", () => {
		const connector = (workspaces: ReadonlyArray<unknown>) =>
			Schema.decodeUnknownSync(V2ChatConnector)({
				id: "slack",
				object: "chat_connector",
				name: "Slack",
				available: true,
				workspaces,
				supports_identity: true,
			})
		const ready = pageUpdate(
			withLists(entered({ template: "slow_p95" })),
			Message.CompletedFetchConnectors({ connectors: [connector([])] }),
		).model
		const menuId = "alert-rule-add-destination-warning"
		const picked = pageUpdate(
			ready,
			Message.GotMenuMessage({
				id: menuId,
				message: Menu.Message.ClickedItem({
					index: 0,
					item: { kind: "Item", value: "connect:slack" },
				}),
			}),
		).model
		expect(picked.chatConnect.active?.connector).toBe("slack")
		const workspace = {
			id: encodePublicId(PublicIdPrefixes.chatWorkspace, "0199a0d5-0000-7000-8000-000000000003"),
			object: "chat_workspace",
			connector: "slack",
			external_workspace_id: "T03",
			name: "Acme Ops",
			settings: {},
			created_at: "2026-09-01T00:00:00.000Z",
		}
		const linked = pageUpdate(
			picked,
			Message.CompletedFetchConnectors({ connectors: [connector([workspace])] }),
		).model
		expect(linked.chatConnect.active).toBeNull()
		expect(linked.destinationDialog.dialog.isOpen).toBe(true)
		expect(linked.destinationDialog.form.type).toBe("chat")
	})

	test("an incomplete rule cannot be saved", () => {
		const unnamed = pageUpdate(withLists(entered()), Message.ChangedField({ field: "name", value: "" }))
		expect(names(pageUpdate(unnamed.model, Message.ClickedSave()).commands)).toEqual([])
	})

	test("switching SQL to Built-in says what it dropped; a template lands in the query builder", () => {
		const sql = pageUpdate(
			entered({ template: "slow_p95" }),
			Message.ClickedSignalKind({ kind: "raw_query" }),
		).model
		const back = pageUpdate(sql, Message.ClickedSignalKind({ kind: "builtin" })).model
		expect(back.kindNotice).toContain("SQL doesn't carry over")
		const picked = pageUpdate(entered(), Message.ClickedTemplate({ id: "slow_p99" })).model
		expect(picked.form?.signalType).toBe("builder_query")
		expect(picked.templates.isOpen).toBe(false)
	})

	test("a tag commits on Enter, canonical and once", () => {
		const model = run(withLists(entered({ template: "slow_p95" })), [
			Message.ChangedTagDraft({ value: " Payments " }),
			Message.PressedTagKey({ key: "Enter" }),
			Message.ChangedTagDraft({ value: "payments" }),
			Message.PressedTagKey({ key: "Enter" }),
		])
		expect(model.form?.tags).toEqual(["payments"])
		expect(model.tagDraft).toBe("")
	})

	// Every section is memoized on what it reads: each step renders the old state first, so a
	// section keyed on the wrong input would keep showing it.
	test("each section follows the edit or sync it reads, after rendering the one before", () => {
		const ready = withLists(entered({ template: "slow_p95" }))
		const firing = Schema.decodeUnknownSync(AlertRulePreviewResponse)({
			bucketSeconds: 300,
			windowMinutes: 5,
			threshold: 1500,
			thresholdUpper: null,
			thresholds: [
				{ severity: "warning", value: 1500, upper: null, recoveryValue: null, destinationIds: [] },
			],
			comparator: "gt",
			truncatedToStart: null,
			series: [
				{
					groupKey: "__ungrouped__",
					points: [
						{
							bucket: "2026-10-01T11:00:00.000Z",
							value: 1800,
							sampleCount: 40,
							status: "breached",
						},
					],
				},
			],
			wouldFire: [
				{
					groupKey: "__ungrouped__",
					start: "2026-10-01T11:00:00.000Z",
					end: "2026-10-01T11:10:00.000Z",
					severity: "warning",
				},
			],
		})
		const edited = pageUpdate(ready, Message.ChangedField({ field: "threshold", value: "1500" })).model
		const sql = pageUpdate(edited, Message.ClickedSignalKind({ kind: "raw_query" })).model
		const answer = (key: string | null) =>
			Message.CompletedFetchPreview({ key: key ?? "", isSaved: false, result: Result.succeed(firing) })
		scene(
			{ update: pageUpdate, view },
			given(ready),
			themeResolved(),
			// Details: the org's tags arrive with the rules sync.
			expectView(selector('option[value="payments"]')).not.toExist(),
			Subscription.emit(
				Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { tags_json: ["payments"] })] }),
			),
			expectView(selector('option[value="payments"]')).toExist(),
			// Details: a name edit, which the query, condition and chart sections skip.
			type(placeholder("Error rate on payments"), "Checkout errors"),
			expectView(placeholder("Error rate on payments")).toHaveValue("Checkout errors"),
			// Notifications: the destinations sync.
			expectView(text(/^Paused/)).not.toExist(),
			Subscription.emit(
				Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow({ enabled: false })] }),
			),
			expectView(text(/^Paused/)).toExist(),
			// Condition, action bar and chart: a threshold edit, then its preview.
			type(selector("#rule-threshold"), "1500"),
			expectView(selector("#rule-threshold")).toHaveValue("1500"),
			expectView(text(/is above 1500/)).toExist(),
			expectView(text("Would have fired")).not.toExist(),
			Command.resolve(FetchEditorPreview, answer(edited.preview.key)),
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("Would have fired")).toExist(),
			// Query: the mode switch.
			expectView(role("button", { name: "Collapse SQL" })).not.toExist(),
			click(role("button", { name: "SQL" })),
			Command.resolve(FetchEditorPreview, answer(sql.preview.key)),
			expectView(role("button", { name: "Collapse SQL" })).toExist(),
		)
	})
})

describe("alert rule editor lazy sections", () => {
	test.each([
		["a new rule on the template picker", () => withLists(entered())],
		["a draft from a template", () => withLists(entered({ template: "slow_p95" }))],
		["a saved rule", () => withLists(entered({ ruleId: ruleId(2) }))],
	])("%s reuses every section on an unchanged render", (_, model) => {
		Lazy.expectAllReused({ view, model: model() })
	})
})
