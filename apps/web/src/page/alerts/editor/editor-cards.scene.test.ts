import { OrgId } from "@maple/domain"
import { Schema, Array as Arr } from "effect"
import {
	click,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import type { PageContext } from "../../contract"
import { scopedAnomalyRuleRow } from "../shared/anomaly-test-fixtures"
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
					"Above 800 ms (critical), over 5 min, 2 checks in a row, resolves after 2 healthy checks",
				),
			).toExist(),
			expectView(summary("Notify", "https://hooks.acme.test/maple")).toExist(),
			expectView(summary("Name", "Rule 2")).toExist(),
			expectView(queryMode).not.toExist(),
			click(summary("When", "P95 latency on payment-svc in production")),
			expectView(queryMode).toExist(),
			expectView(role("heading", { name: "When" })).toExist(),
			click(role("button", { name: "Done" })),
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
})
