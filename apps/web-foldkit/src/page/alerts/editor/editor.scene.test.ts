import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import type { PageContext } from "../../contract"
import { destinationRow, NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
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
