import { OrgId } from "@maple/domain"
import { AlertDestinationId } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
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
		const unrouted = run(opened({ template: "anomaly", serviceName: "search" }), [
			Message.ChangedField({ field: "name", value: "Search anomalies" }),
			Message.ClickedRemoveDestination({ tier: "warning", id: DESTINATION }),
		])
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
})
