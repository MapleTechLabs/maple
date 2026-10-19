import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, V2ChatConnector } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import * as Animation from "@foldkit/ui/animation"
import { click, Command, expect as expectView, given, hover, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import * as Menu from "../../../ui/menu"
import * as Tooltip from "../../../ui/tooltip"
import type { PageContext } from "../../contract"
import { destinationRow, NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
import { ReloadPage } from "./command"
import { init } from "./init"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const DRAFT_ID = "6f1c2e3a-0000-4000-8000-000000000001"
const themeResolved = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

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
		expect(names(start.commands)).toEqual([
			"GenerateAlertDraftId",
			"ReadAlertEditorClock",
			"ReadAlertEditorIsAdmin",
			"FetchAlertEditorConnectors",
			"LoadChartRuntime",
		])
		const drafted = pageUpdate(start.model, Message.GeneratedDraftId({ id: DRAFT_ID }))
		expect(drafted.model.form?.signalType).toBe("builder_query")
		expect(drafted.model.form?.queryBuilderDraft.id).toBe(DRAFT_ID)
		expect(drafted.model.templates.isOpen).toBe(true)
		const clocked = pageUpdate(drafted.model, Message.CompletedReadClock({ nowMs: NOW }))
		expect(names(clocked.commands)).toContain("FetchAlertEditorPreview")
		expect(names(clocked.commands).filter((name) => name === "FetchAlertEditorAutocomplete")).toHaveLength(6)
		expect(names(clocked.commands)).toContain("FetchAlertEditorTraceFacets")
	})

	test("editing waits for the rules, then opens on the saved rule without a default destination", () => {
		const waiting = entered({ ruleId: ruleId(2) })
		expect(waiting.form).toBeNull()
		const ready = withLists(waiting)
		expect(ready.form?.name).toBe("Payment p95 latency")
		expect(ready.savedForm).toEqual(ready.form)
		expect(ready.editingRuleId).toBe(ruleId(2))
		scene({ update: pageUpdate, view }, given(ready), themeResolved(), expectView(text("Save changes")).toExist())
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
			Message.CompletedFetchPreview({ key: staleKey, isSaved: false, result: Result.fail({ message: "late" }) }),
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
		const failed = pageUpdate(saving, Message.CompletedSave({ result: Result.fail({ title: "Bad", message: "nope" }) }))
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
			Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
			Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
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
		const failed = pageUpdate(withLists(entered(search)), Message.FailedLoadDashboards({ orgId: ORG })).model
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
		const ready = pageUpdate(withLists(entered({ template: "slow_p95" })), Message.CompletedFetchConnectors({ connectors: [connector([])] })).model
		const menuId = "alert-rule-add-destination-warning"
		const picked = pageUpdate(
			ready,
			Message.GotMenuMessage({ id: menuId, message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: "connect:slack" } }) }),
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
		const linked = pageUpdate(picked, Message.CompletedFetchConnectors({ connectors: [connector([workspace])] })).model
		expect(linked.chatConnect.active).toBeNull()
		expect(linked.destinationDialog.dialog.isOpen).toBe(true)
		expect(linked.destinationDialog.form.type).toBe("chat")
	})

	test("an incomplete rule cannot be saved", () => {
		const unnamed = pageUpdate(withLists(entered()), Message.ChangedField({ field: "name", value: "" }))
		expect(names(pageUpdate(unnamed.model, Message.ClickedSave()).commands)).toEqual([])
	})

	test("switching SQL to Built-in says what it dropped; a template lands in the query builder", () => {
		const sql = pageUpdate(entered({ template: "slow_p95" }), Message.ClickedSignalKind({ kind: "raw_query" })).model
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
})
