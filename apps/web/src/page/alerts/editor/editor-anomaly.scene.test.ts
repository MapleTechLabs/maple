import { OrgId } from "@maple/domain"
import { AlertDestinationId } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import {
	click,
	expect as expectView,
	given,
	Mount,
	placeholder,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as Menu from "@maple/views/ui/menu"
import * as DestinationDialog from "../destination/dialog"
import { menuIdOf } from "./dest-steps"
import type { PageContext } from "../../contract"
import { defaultAnomalyRuleRow, scopedAnomalyRuleRow } from "../shared/anomaly-test-fixtures"
import { DESTINATION_ID, destinationRow, NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
import { init } from "./init"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const DESTINATION = Schema.decodeSync(AlertDestinationId)(DESTINATION_ID)
const DRAFT_ID = "6f1c2e3a-0000-4000-8000-000000000001"
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const opened = (
	search: Model["search"],
	rules = [ruleRow(2), defaultAnomalyRuleRow(), scopedAnomalyRuleRow()],
) =>
	run(init({ _tag: "AlertsCreate", search }, context).model, [
		Message.GeneratedDraftId({ id: DRAFT_ID }),
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		Message.UpdatedRules({ orgId: ORG, rows: rules }),
	])

/** A pick from a tier's "Add destination" menu of a destination the org already has. */
const pickExisting = (tier: "warning" | "critical", id: string) =>
	Message.GotMenuMessage({
		id: menuIdOf(tier),
		message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: `existing:${id}` } }),
	})

const DESCRIPTION = /^Pages when Maple detects unusual error rate, latency, throughput/
const DEFAULT_NOTE = /^This is the default anomaly rule/

describe("alert rule editor: anomaly rules", () => {
	test("the Anomaly kind keeps scope and per-tier destinations and drops the condition and chart", () => {
		const blank = opened({ template: "slow_p95" })
		scene(
			{ update: pageUpdate, view },
			given(blank),
			themeResolved(),
			expectView(text("When to alert")).toExist(),
			click(role("button", { name: "Anomaly" })),
			expectView(text(DESCRIPTION)).toExist(),
			expectView(text("When to alert")).not.toExist(),
			expectView(role("button", { name: "Dry run" })).not.toExist(),
			expectView(role("group", { name: "Anomaly signals" })).toExist(),
			expectView(text("None picked: every signal pages.")).toExist(),
			expectView(text("Critical, on top of the warning destinations")).toExist(),
		)
	})

	test("picking signals narrows the rule, and saving sends the scope with both pinned tiers", () => {
		const anomaly = run(opened({ template: "anomaly" }), [
			Message.ChangedField({ field: "name", value: "Checkout anomalies" }),
			Message.ToggledAnomalySignal({ signal: "error_spike" }),
			Message.ToggledAnomalySignal({ signal: "error_rate" }),
			pickExisting("critical", DESTINATION),
		])
		// Kept in the editor's order, whatever the click order.
		expect(anomaly.form?.anomalySignals).toEqual(["error_rate", "error_spike"])
		const saved = pageUpdate(anomaly, Message.ClickedSave())
		const payload = saved.commands?.[0]?.args
		expect(saved.commands?.[0]?.name).toBe("SaveAlertRule")
		expect(payload).toMatchObject({
			payload: {
				signal_type: "anomaly",
				anomaly_signals: ["error_rate", "error_spike"],
				thresholds: [
					expect.objectContaining({ severity: "warning", value: 1 }),
					expect.objectContaining({ severity: "critical", value: 2 }),
				],
			},
		})
	})

	test("a scoped anomaly rule with nobody to page cannot be saved", () => {
		const routed = run(opened({ template: "anomaly" }), [
			Message.ChangedField({ field: "name", value: "Error rate anomalies" }),
			Message.ToggledAnomalySignal({ signal: "error_rate" }),
			pickExisting("warning", DESTINATION),
		])
		// Scoped and routed: the only thing left to take away is the destination.
		scene(
			{ update: pageUpdate, view },
			given(routed),
			themeResolved(),
			expectView(role("button", { name: "Create rule" })).toBeEnabled(),
		)
		const unrouted = pageUpdate(
			routed,
			Message.ClickedRemoveDestination({ tier: "warning", id: DESTINATION }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(unrouted),
			themeResolved(),
			expectView(text("Who gets notified")).toExist(),
			expectView(role("button", { name: "Create rule" })).toBeDisabled(),
		)
	})

	test("editing a scoped anomaly rule opens on its scope and keeps the save unchanged", () => {
		const scoped = opened({ ruleId: ruleId(8) })
		expect(scoped.form?.signalType).toBe("anomaly")
		expect(scoped.form?.serviceNames).toEqual(["checkout"])
		expect(scoped.form?.anomalySignals).toEqual(["error_rate", "latency_p95"])
		scene(
			{ update: pageUpdate, view },
			given(scoped),
			themeResolved(),
			expectView(text("No changes")).toExist(),
			expectView(text(DEFAULT_NOTE)).not.toExist(),
			// Each chip's remove button names its chip.
			expectView(role("button", { name: "Remove checkout" })).toExist(),
			expectView(role("button", { name: "Error rate" })).not.toBeDisabled(),
		)
	})

	test("the default anomaly rule locks its kind and scope and says why", () => {
		const fallback = opened({ ruleId: ruleId(7) })
		scene(
			{ update: pageUpdate, view },
			given(fallback),
			themeResolved(),
			expectView(text(DEFAULT_NOTE)).toExist(),
			expectView(role("button", { name: "Error rate" })).toBeDisabled(),
			expectView(role("button", { name: "Built-in" })).toBeDisabled(),
		)
		// A stale click still cannot scope it or turn it into a query rule.
		const poked = run(fallback, [
			Message.ToggledAnomalySignal({ signal: "throughput" }),
			Message.ClickedSignalKind({ kind: "builtin" }),
		])
		expect(poked.form).toEqual(fallback.form)
	})

	test("the default anomaly rule saves unrouted, since anomaly paging is opt-in", () => {
		const renamed = run(opened({ ruleId: ruleId(7) }), [
			Message.ChangedField({ field: "name", value: "Anomalies (everything else)" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(renamed),
			themeResolved(),
			expectView(text("Ready to save")).toExist(),
			expectView(role("button", { name: "Save changes" })).not.toBeDisabled(),
		)
		const saved = pageUpdate(renamed, Message.ClickedSave())
		expect(saved.commands?.[0]?.name).toBe("SaveAlertRule")
	})

	test("the server's refusal is shown as the save error", () => {
		const fallback = run(opened({ ruleId: ruleId(7) }), [
			Message.ClickedAddNotes(),
			Message.ChangedField({ field: "notes", value: "Pages the platform team" }),
		])
		const saving = pageUpdate(fallback, Message.ClickedSave()).model
		const message =
			"The default anomaly rule cannot be deleted or disabled; turn anomaly detection off in anomaly settings instead"
		const failed = pageUpdate(
			saving,
			Message.CompletedSave({ result: Result.fail({ title: "Couldn't save rule", message }) }),
		)
		expect(failed.model.isSaving).toBe(false)
		expect(failed.outMessage).toMatchObject({ title: "Couldn't save rule", description: message })
	})

	test("a destination created from the Critical tier joins the Critical tier", () => {
		const NEW_ID = Schema.decodeSync(AlertDestinationId)("0199a001-0000-7000-8000-000000000009")
		const draft = run(opened({ template: "anomaly", serviceName: "checkout" }), [
			Message.ChangedField({ field: "name", value: "Checkout anomalies" }),
			pickExisting("warning", DESTINATION),
		])
		const opening = run(draft, [
			Message.GotMenuMessage({
				id: menuIdOf("critical"),
				message: Menu.Message.ClickedItem({
					index: 0,
					item: { kind: "Item", value: "type:webhook" },
				}),
			}),
		])
		expect(opening.destinationDialog.dialog.isOpen).toBe(true)
		const created = run(opening, [
			Message.GotDestinationDialogMessage({
				message: DestinationDialog.Message.CompletedSave({
					openCount: opening.destinationDialog.openCount,
					isCreate: true,
					result: Result.succeed(NEW_ID),
				}),
			}),
			Message.UpdatedDestinations({
				orgId: ORG,
				rows: [destinationRow(), destinationRow({ id: NEW_ID, name: "Pager bridge" })],
			}),
		])
		expect(created.form?.escalation?.destinationIds).toEqual([NEW_ID])
		expect(created.form?.destinationIds).not.toContain(NEW_ID)
		scene(
			{ update: pageUpdate, view },
			// The dialog's close transition is the dialog's own story: the tier lists are what matter here.
			given({ ...created, destinationDialog: draft.destinationDialog }),
			themeResolved(),
			expectView(text(/Pager bridge/)).toExist(),
		)
		const saved = pageUpdate(created, Message.ClickedSave())
		expect(saved.commands?.[0]?.args).toMatchObject({
			payload: {
				thresholds: [
					expect.objectContaining({ severity: "warning", destination_ids: [DESTINATION] }),
					expect.objectContaining({ severity: "critical", destination_ids: [NEW_ID] }),
				],
			},
		})
	})

	test("a new anomaly rule needs a service, environment or signal; the default rule covers the rest", () => {
		const unscoped = run(opened({ template: "anomaly" }), [
			Message.ChangedField({ field: "name", value: "Everything" }),
			pickExisting("critical", DESTINATION),
		])
		scene(
			{ update: pageUpdate, view },
			given(unscoped),
			themeResolved(),
			expectView(text(/^Pick at least one service, environment or signal/)).toExist(),
			expectView(role("button", { name: "Create rule" })).toBeDisabled(),
			click(role("button", { name: "Throughput" })),
			expectView(text(/^Pick at least one service, environment or signal/)).not.toExist(),
			expectView(role("button", { name: "Create rule" })).not.toBeDisabled(),
		)
		expect(pageUpdate(unscoped, Message.ClickedSave()).commands ?? []).toHaveLength(0)
	})

	test("an anomaly rule's name suggests what it covers", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened({ template: "anomaly" })),
			themeResolved(),
			expectView(placeholder("Checkout anomalies")).toExist(),
		)
	})

	test("a new anomaly rule pages nobody until picked, and a destination picked for Critical leaves Warning", () => {
		const fresh = opened({ template: "anomaly", serviceName: "checkout" })
		// Anomaly paging is opt-in: the org's usual destination is not pre-selected.
		expect(fresh.form?.destinationIds).toEqual([])
		expect(fresh.form?.escalation?.destinationIds).toEqual([])
		const onWarning = run(fresh, [pickExisting("warning", DESTINATION)])
		expect(onWarning.form?.destinationIds).toEqual([DESTINATION])
		const moved = run(onWarning, [pickExisting("critical", DESTINATION)])
		expect(moved.form?.destinationIds).toEqual([])
		expect(moved.form?.escalation?.destinationIds).toEqual([DESTINATION])
	})

	test("a failed Send test says the notification failed, not the preview", () => {
		const draft = run(opened({ template: "anomaly", serviceName: "checkout" }), [
			Message.ChangedField({ field: "name", value: "Checkout anomalies" }),
			pickExisting("critical", DESTINATION),
		])
		const sending = pageUpdate(draft, Message.ClickedSendTest())
		expect(sending.commands?.[0]?.name).toBe("RunAlertRuleTest")
		const failed = pageUpdate(
			sending.model,
			Message.CompletedTest({
				isSending: true,
				key: "",
				result: Result.fail({
					title: "Alert provider rejected the request",
					message: "The alert provider rejected the request.",
				}),
			}),
		)
		expect(failed.outMessage).toMatchObject({
			title: "Couldn't send test notification",
			description: "The alert provider rejected the request.",
		})
		const dryRun = pageUpdate(
			draft,
			Message.CompletedTest({
				isSending: false,
				key: "",
				result: Result.fail({ title: "Bad", message: "The query timed out." }),
			}),
		)
		expect(dryRun.outMessage).toMatchObject({ title: "Couldn't preview rule" })
	})

	test("a tiered threshold rule keeps one destination on both tiers and saves", () => {
		const tiered = run(opened({ template: "slow_p95" }), [
			Message.ChangedField({ field: "name", value: "Slow checkout" }),
			Message.ClickedAddCriticalTier(),
			pickExisting("critical", DESTINATION),
		])
		expect(tiered.form?.destinationIds).toEqual([DESTINATION])
		expect(tiered.form?.escalation?.destinationIds).toEqual([DESTINATION])
		const saved = pageUpdate(tiered, Message.ClickedSave())
		expect(saved.commands?.[0]?.name).toBe("SaveAlertRule")
	})

	test("switching to Anomaly drops the destination the editor pre-selected, not one the user picked", () => {
		const blank = opened({})
		// A new query rule starts on the org's usual destination.
		expect(blank.form?.destinationIds).toEqual([DESTINATION])
		const anomaly = pageUpdate(blank, Message.ClickedSignalKind({ kind: "anomaly" })).model
		expect(anomaly.form?.destinationIds).toEqual([])
		expect(anomaly.form?.escalation?.destinationIds).toEqual([])
		const chosen = run(blank, [
			Message.ClickedRemoveDestination({ tier: "warning", id: DESTINATION }),
			pickExisting("warning", DESTINATION),
			Message.ClickedSignalKind({ kind: "anomaly" }),
		])
		expect(chosen.form?.destinationIds).toEqual([DESTINATION])
	})
})
