import { OrgId } from "@maple/domain"
import { AlertRulePreviewResponse } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import * as Animation from "@foldkit/ui/animation"
import {
	all,
	click,
	Command,
	expect as expectView,
	expectAll,
	given,
	keydown,
	Mount,
	role,
	scene,
	selector,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as Dialog from "@maple/views/ui/dialog"
import type { PageContext } from "../../contract"
import { scopedAnomalyRuleRow } from "../shared/anomaly-test-fixtures"
import { destinationRow, NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
import * as Select from "@maple/views/ui/select"
import { FocusRuleCard } from "./command"
import { BREACH_MODE_SELECT_ID } from "./form-steps"
import { init } from "./init"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const opened = (search: Model["search"], rules = [ruleRow(2)]) =>
	run(init({ _tag: "AlertsCreate", search }, context).model, [
		Message.GeneratedDraftId({ id: "6f1c2e3a-0000-4000-8000-000000000001" }),
		Message.CompletedReadClock({ nowMs: NOW }),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		Message.UpdatedRules({ orgId: ORG, rows: rules }),
	])

const SQL =
	"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket ORDER BY bucket"

/** A preview whose one check takes 7.8s: too slow for 1-minute checks. */
const slowPreview = () =>
	Schema.decodeSync(AlertRulePreviewResponse)({
		bucketSeconds: 300,
		windowMinutes: 5,
		threshold: 800,
		thresholdUpper: null,
		thresholds: [
			{ severity: "critical", value: 800, upper: null, recoveryValue: null, destinationIds: [] },
		],
		comparator: "gt",
		truncatedToStart: null,
		series: [],
		wouldFire: [],
		queryTiming: {
			elapsedMs: 7_800,
			failure: null,
			probeLimitMs: 25_000,
			intervalMinutes: 1,
			limitMs: 5_000,
			fitsIntervalMinutes: [5, 10, 15, 30, 60],
		},
	})

const summary = (lead: string, rest: string) => role("button", { name: `${lead}: ${rest}. Edit` })
const queryMode = role("button", { name: "Built-in" })

describe("alert rule editor, sentence cards", () => {
	test("a saved rule opens on one-line summaries; clicking one opens its card, Done closes it", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened({ ruleId: ruleId(2) })),
			themeResolved(),
			expectView(summary("When", "P95 latency on payment-svc in production")).toExist(),
			expectView(
				summary(
					"Alert when",
					"Above 800 ms (critical), in 2 checks in a row (5 min each), resolves after 2 healthy checks",
				),
			).toExist(),
			expectView(summary("Notify", "https://hooks.acme.test/maple")).toExist(),
			expectView(summary("Name", "Rule 2")).toExist(),
			expectView(queryMode).not.toExist(),
			click(summary("When", "P95 latency on payment-svc in production")),
			// Opening moves focus to the card's heading; closing returns it to the summary.
			Command.expectHas(FocusRuleCard({ id: "sentence-card-watch" })),
			Command.resolve(FocusRuleCard, Message.CompletedFocusCard()),
			expectView(queryMode).toExist(),
			expectView(role("heading", { name: "When" })).toExist(),
			click(role("button", { name: "Done" })),
			Command.expectHas(FocusRuleCard({ id: "sentence-card-watch-summary" })),
			Command.resolve(FocusRuleCard, Message.CompletedFocusCard()),
			expectView(queryMode).not.toExist(),
			expectView(summary("When", "P95 latency on payment-svc in production")).toExist(),
		)
	})

	test("a card with something missing stays open, and stays open once it is filled in", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened({ ruleId: ruleId(2) }, [ruleRow(2, { name: "" })])),
			themeResolved(),
			expectView(text("Missing: Rule name")).toExist(),
			expectView(role("textbox", { name: "Rule name" })).toExist(),
			type(role("textbox", { name: "Rule name" }), "Payment latency"),
			expectView(text("Missing: Rule name")).not.toExist(),
			expectView(role("textbox", { name: "Rule name" })).toExist(),
			expectView(summary("When", "P95 latency on payment-svc in production")).toExist(),
		)
	})

	test("a new rule opens every card", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened({ template: "slow_p95" })),
			themeResolved(),
			expectView(queryMode).toExist(),
			expectView(role("heading", { name: "Alert when" })).toExist(),
			expectView(role("heading", { name: "Notify" })).toExist(),
			expectView(role("textbox", { name: "Rule name" })).toExist(),
		)
	})

	test("with a threshold that is not a number, the empty chart asks for one, not for a signal", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				run(opened({ template: "slow_p95" }), [
					Message.ChangedField({ field: "threshold", value: "-" }),
				]),
			),
			themeResolved(),
			expectView(text(/^Enter a number for the threshold to preview it against the last/u)).toExist(),
			expectView(text(/^Pick a signal/u)).not.toExist(),
		)
	})

	test("an anomaly rule reads as its scope and has no Alert when card", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened({ ruleId: ruleId(8) }, [scopedAnomalyRuleRow()])),
			themeResolved(),
			expectView(
				summary("When", "Anomalies in checkout · production · Error rate, p95 latency"),
			).toExist(),
			expectView(text("Alert when")).not.toExist(),
		)
	})

	test("the action bar says one thing: no changes, ready, or what to fix", () => {
		const saved = opened({ ruleId: ruleId(2) })
		scene(
			{ update: pageUpdate, view },
			given(saved),
			themeResolved(),
			expectView(text("No changes")).toExist(),
			expectView(text("Ready to save")).not.toExist(),
			expectView(role("button", { name: "Save changes" })).toBeDisabled(),
		)
		const edited = run(saved, [Message.ChangedField({ field: "threshold", value: "900" })])
		scene(
			{ update: pageUpdate, view },
			given(edited),
			themeResolved(),
			expectView(text("Ready to save")).toExist(),
			expectView(text("No changes")).not.toExist(),
			expectView(text("1 unsaved change")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeEnabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(run(edited, [Message.ChangedField({ field: "name", value: "" })])),
			themeResolved(),
			expectView(text("Fix before saving:")).toExist(),
			expectView(text("Ready to save")).not.toExist(),
			expectView(role("button", { name: "Rule name" })).toExist(),
		)
	})

	test("a thing to fix in the action bar opens its card and focuses its field", () => {
		const blank = run(opened({ ruleId: ruleId(2) }), [
			Message.ChangedField({ field: "threshold", value: "" }),
			Message.ClickedCollapseCard({ card: "name" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(blank),
			themeResolved(),
			expectView(role("textbox", { name: "Rule name" })).not.toExist(),
			click(role("button", { name: "Threshold" })),
			Command.expectHas(FocusRuleCard({ id: "rule-threshold" })),
			Command.resolve(FocusRuleCard, Message.CompletedFocusCard()),
			// The field it lands on now shows its error.
			expectView(selector("#rule-threshold")).toHaveAttr("aria-invalid", "true"),
		)
		// An issue on a closed card opens the card first.
		const next = pageUpdate(opened({ ruleId: ruleId(2) }), Message.ClickedIssue({ issue: "Rule name" }))
		expect(next.model.expandedCards).toContain("name")
		expect(Arr.map(next.commands ?? [], ({ name }) => name)).toEqual(["FocusAlertRuleCard"])
	})

	test("a pristine form shows no red errors until a field is left or save is pressed", () => {
		// A new rule in an org with no destination: Notify and Name are missing from the start.
		const pristine = run(
			init({ _tag: "AlertsCreate", search: { template: "slow_p95" } }, context).model,
			[
				Message.GeneratedDraftId({ id: "6f1c2e3a-0000-4000-8000-000000000001" }),
				Message.CompletedReadClock({ nowMs: NOW }),
				Message.UpdatedDestinations({ orgId: ORG, rows: [] }),
				Message.UpdatedRules({ orgId: ORG, rows: [] }),
				Message.ChangedField({ field: "name", value: "" }),
			],
		)
		const routeError = text("Pick a destination or an escalation chain")
		scene(
			{ update: pageUpdate, view },
			given(pristine),
			themeResolved(),
			expectView(text("Missing: Who gets notified")).toExist(),
			expectView(text("Missing: Rule name")).toExist(),
			expectAll(all.selector('[aria-invalid="true"]')).toHaveCount(0),
			expectView(routeError).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			// Leaving the empty name shows its error, and only its own.
			given(run(pristine, [Message.BlurredField({ id: "rule-name" })])),
			themeResolved(),
			expectView(role("textbox", { name: "Rule name" })).toHaveAttr("aria-invalid", "true"),
			expectView(routeError).not.toExist(),
			// Pressing save shows the rest, and lands on the first thing to fix.
			click(role("button", { name: "Create rule" })),
			Command.expectHas(FocusRuleCard({ id: "rule-name" })),
			Command.resolve(FocusRuleCard, Message.CompletedFocusCard()),
			expectView(routeError).toExist(),
		)
	})

	test("Escape inside an open, complete card collapses it and returns focus to its summary", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened({ ruleId: ruleId(2) })),
			themeResolved(),
			click(summary("When", "P95 latency on payment-svc in production")),
			Command.resolve(FocusRuleCard, Message.CompletedFocusCard()),
			keydown(role("region", { name: "When" }), "Escape"),
			Command.expectHas(FocusRuleCard({ id: "sentence-card-watch-summary" })),
			Command.resolve(FocusRuleCard, Message.CompletedFocusCard()),
			expectView(summary("When", "P95 latency on payment-svc in production")).toExist(),
			expectView(queryMode).not.toExist(),
		)
		// A card with something missing has nothing to collapse to: Escape is not handled.
		scene(
			{ update: pageUpdate, view },
			given(opened({ ruleId: ruleId(2) }, [ruleRow(2, { name: "" })])),
			themeResolved(),
			expectView(role("region", { name: "Name" })).not.toHaveHandler("keydown"),
			expectView(role("button", { name: "Done" })).not.toExist(),
		)
	})

	test("Start blank closes the templates dialog and unmounts it, leaving nothing over the form", () => {
		const fresh = run(init({ _tag: "AlertsCreate", search: {} }, context).model, [
			Message.GeneratedDraftId({ id: "6f1c2e3a-0000-4000-8000-000000000001" }),
			Message.CompletedReadClock({ nowMs: NOW }),
		])
		expect(fresh.templates.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(fresh),
			themeResolved(),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("dialog")).toExist(),
			click(role("button", { name: /^Start blank/ })),
			// The exit transition settles, then the dialog leaves the tree.
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 2 }),
			),
			Command.resolve(
				Dialog.WaitForDialogTransition,
				Dialog.Message.GotAnimationMessage({
					message: Animation.Message.EndedAnimation({ generation: 2 }),
				}),
			),
			Mount.expectEnded(Dialog.MountDialog),
			expectView(role("dialog")).not.toExist(),
			expectView(text("Start with a template")).not.toExist(),
		)
	})

	test("breaches count in a row, or out of the last N once that is picked", () => {
		const draft = opened({ template: "slow_p95" })
		const pick = (value: string) =>
			Message.GotSelectMessage({
				id: BREACH_MODE_SELECT_ID,
				message: Select.Message.SelectedItem({ index: 0, value }),
			})
		const mode = role("combobox", { name: "How breaches are counted" })
		scene(
			{ update: pageUpdate, view },
			given(draft),
			themeResolved(),
			expectView(mode).toContainText("in a row"),
			expectView(selector("#rule-breaches-out-of")).not.toExist(),
		)
		const windowed = run(draft, [pick("window")])
		scene(
			{ update: pageUpdate, view },
			given(windowed),
			themeResolved(),
			expectView(mode).toContainText("out of the last"),
			expectView(selector("#rule-breaches-out-of")).toHaveValue(windowed.form?.breachesOutOf ?? ""),
		)
		// Retyping N passes through empty: the field stays until "in a row" is picked.
		const emptied = run(windowed, [Message.ChangedField({ field: "breachesOutOf", value: "" })])
		scene(
			{ update: pageUpdate, view },
			given(emptied),
			themeResolved(),
			expectView(selector("#rule-breaches-out-of")).toExist(),
		)
		expect(run(emptied, [pick("row")]).isBreachWindowOpen).toBe(false)
	})

	test("a SQL rule whose timing lands too slow opens Alert when with the blocker", () => {
		const sql = opened({ ruleId: ruleId(2) }, [
			ruleRow(2, { signal_type: "raw_query", raw_query_sql: SQL }),
		])
		expect(sql.expandedCards).toEqual([])
		const timed = pageUpdate(
			sql,
			Message.CompletedFetchPreview({
				key: sql.preview.key ?? "",
				isSaved: false,
				result: Result.succeed(slowPreview()),
			}),
		).model
		expect(timed.expandedCards).toContain("condition")
		scene(
			{ update: pageUpdate, view },
			given(timed),
			themeResolved(),
			expectView(text("Query too slow for this check interval")).toExist(),
		)
	})
})
