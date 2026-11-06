import { OrgId } from "@maple/domain"
import { AlertRuleId } from "@maple/domain/http"
import { Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import type { PageContext } from "../../contract"
import { anomalyIncidentRow, anomalyRuleRow, defaultAnomalyRuleRow } from "../shared/anomaly-test-fixtures"
import { DESTINATION_ID, destinationRow, NOW, ORG, stateRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const SCOPED = anomalyRuleRow(8, {
	name: "Demo API anomalies",
	service_names_json: ["demo-api"],
	anomaly_signals_json: ["error_rate", "latency_p95"],
	criticalIds: [DESTINATION_ID],
})

const loaded = (
	rule = SCOPED,
	incidents = [
		anomalyIncidentRow({
			n: 1,
			ruleN: 8,
			severity: "critical",
			service: "demo-api",
			environment: "production",
		}),
	],
) => {
	const entered = init(
		{ _tag: "AlertRule", ruleId: Schema.decodeSync(AlertRuleId)(rule.id), search: {} },
		context,
	)
	return Arr.reduce(
		[
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
			Message.ReadDiagnosisClock({ nowMs: NOW }),
			Message.UpdatedRules({ orgId: ORG, rows: [rule] }),
			// The anomaly heartbeat row: its key is the ungrouped one, not a group anyone picked.
			Message.UpdatedRuleStates({
				orgId: ORG,
				rows: [
					stateRow(0, {
						rule_id: rule.id,
						group_key: "__total__",
						last_value: 2,
					}),
				],
			}),
			Message.UpdatedIncidents({ orgId: ORG, rows: incidents }),
			Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		],
		entered.model,
		(model, message) => pageUpdate(model, message).model,
	)
}

describe("alert rule page: anomaly rules", () => {
	test("says what the rule pages on, and never asks for a query replay", () => {
		const model = loaded()
		expect(model.preview.key).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(
				text("Pages on anomalies in demo-api · all environments · Error rate, p95 latency"),
			).toExist(),
			expectView(text(/^Anomalies: /)).toExist(),
			expectView(text("Anomaly on demo-api (production)")).toExist(),
			expectView(text(/^The rule's query, replayed/)).not.toExist(),
			expectView(text("Breaches to fire")).not.toExist(),
			expectView(text("Min samples")).not.toExist(),
			expectView(text("Threshold compared")).not.toExist(),
			expectView(text("Group")).not.toExist(),
			expectView(text("__total__")).not.toExist(),
		)
	})

	test("configuration lists scope, signals, each tier's destinations and the cadence", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			themeResolved(),
			expectView(text("Signals")).toExist(),
			expectView(text("p95 latency")).toExist(),
			expectView(text("Nobody")).toExist(),
			expectView(text("On-call webhook")).toExist(),
			expectView(text("every 1m")).toExist(),
		)
	})

	test("an unrouted default rule reads as opt-in, with no anomalies in the window said plainly", () => {
		const fallback = loaded(defaultAnomalyRuleRow(), [])
		expect(names(pageUpdate(fallback, Message.ClickedReload()).commands)).not.toContain(
			"FetchAlertRulePreview",
		)
		scene(
			{ update: pageUpdate, view },
			given(fallback),
			themeResolved(),
			expectView(text("No anomalies in this window.")).toExist(),
			expectView(text(/fires into the void/)).not.toExist(),
			expectView(text("Configure destinations")).not.toExist(),
		)
	})
})
