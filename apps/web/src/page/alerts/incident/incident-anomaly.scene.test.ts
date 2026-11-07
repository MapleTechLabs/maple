import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertSilenceId } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import {
	anomalyAlertIncidentId,
	anomalyId,
	anomalyIncidentRow,
	anomalyTimeseriesWire,
	anomalyWire,
	defaultAnomalyRuleRow,
} from "../shared/anomaly-test-fixtures"
import { NOW, ORG, ruleId } from "../shared/test-rows"
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
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const SPIKE = {
	n: 3,
	ruleN: 7,
	severity: "critical",
	service: "checkout",
	environment: "production",
} as const

const synced = (scenario: Parameters<typeof anomalyIncidentRow>[0]) =>
	run(
		init({ _tag: "AlertIncident", incidentId: anomalyAlertIncidentId(scenario.n), search: {} }, context)
			.model,
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [anomalyIncidentRow(scenario)] }),
			Message.UpdatedRules({ orgId: ORG, rows: [defaultAnomalyRuleRow()] }),
		],
	)

describe("alert incident: anomaly rules", () => {
	test("an anomaly incident reads its anomaly and series, never a rule preview or checks", () => {
		const entered = init(
			{ _tag: "AlertIncident", incidentId: anomalyAlertIncidentId(3), search: {} },
			context,
		)
		const clocked = pageUpdate(entered.model, Message.ReadClock({ nowMs: NOW })).model
		const withIncident = pageUpdate(
			clocked,
			Message.UpdatedIncidents({ orgId: ORG, rows: [anomalyIncidentRow(SPIKE)] }),
		)
		expect(names(withIncident.commands)).toEqual(
			expect.arrayContaining(["FetchAlertIncidentAnomaly", "FetchAlertIncidentAnomalyTimeseries"]),
		)
		const withRule = pageUpdate(
			withIncident.model,
			Message.UpdatedRules({ orgId: ORG, rows: [defaultAnomalyRuleRow()] }),
		)
		expect(names(withRule.commands)).not.toContain("FetchAlertIncidentPreview")
		expect(names(withRule.commands)).not.toContain("FetchAlertIncidentChecks")
	})

	test("the evidence shows the detector's values, grouped errors and the way to the anomaly", () => {
		const model = synced(SPIKE)
		const loaded = run(model, [
			Message.CompletedFetchAnomaly({
				key: model.anomaly.key ?? "",
				result: Result.succeed(anomalyWire(3, "error_spike", "critical", "checkout")),
			}),
			Message.CompletedFetchAnomalyTimeseries({
				key: model.anomalyTimeseries.key ?? "",
				result: Result.succeed(anomalyTimeseriesWire("error_spike")),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(text("Anomaly on checkout (production)")).toExist(),
			expectView(text("Anomaly · checkout (production)")).toExist(),
			expectView(text(/^Observed/)).toExist(),
			expectView(text("Error frequency increase")).toExist(),
			expectView(text("Grouped errors · 2")).toExist(),
			expectView(text("triaging…")).toExist(),
			expectView(role("link", { name: /Open anomaly/ })).toHaveAttr(
				"href",
				`/anomalies/${anomalyId(3)}`,
			),
			expectView(role("link", { name: /Open issue/ })).toExist(),
			// The rule's pinned severity code is never read out as a threshold.
			expectView(text(/≥ 1|at or above 1/)).not.toExist(),
		)
	})

	test("an investigation of an anomaly sends the detector's readings, never severity codes", () => {
		const model = synced(SPIKE)
		const asked = pageUpdate(
			model,
			Message.CompletedFetchInvestigation({
				key: model.investigation.key ?? "",
				result: Result.succeed(null),
			}),
		).model
		const factsOf = (from: typeof model) =>
			JSON.stringify(pageUpdate(from, Message.ClickedInvestigate()).commands?.[0]?.args ?? {})
		// Before the evidence loads there are no facts to send rather than "Observed: Critical".
		expect(factsOf(asked)).not.toMatch(/Critical|Warning|Threshold/)
		const loaded = pageUpdate(
			asked,
			Message.CompletedFetchAnomaly({
				key: asked.anomaly.key ?? "",
				result: Result.succeed(anomalyWire(3, "error_spike", "critical", "checkout")),
			}),
		).model
		const facts = factsOf(loaded)
		expect(facts).toContain("Baseline")
		expect(facts).toContain("Error frequency increase")
		expect(facts).not.toMatch(/"Threshold"|"Critical"/)
	})

	test("a warning anomaly without grouped errors has no fingerprint list or issue link", () => {
		const scenario = { ...SPIKE, n: 4, severity: "warning" } as const
		const model = synced(scenario)
		const loaded = run(model, [
			Message.CompletedFetchAnomaly({
				key: model.anomaly.key ?? "",
				result: Result.succeed(anomalyWire(4, "latency_p95", "warning", "checkout")),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(text("p95 latency")).toExist(),
			expectView(text(/^Grouped errors/)).not.toExist(),
			expectView(role("link", { name: /Open issue/ })).not.toExist(),
		)
	})

	test("an anomaly that cannot be read still links to its page", () => {
		const model = synced(SPIKE)
		const failed = pageUpdate(
			model,
			Message.CompletedFetchAnomaly({
				key: model.anomaly.key ?? "",
				result: Result.fail(toLoadFailure(new Error("timed out"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Couldn't load the anomaly behind this incident.")).toExist(),
			expectView(role("link", { name: /Open anomaly/ })).toExist(),
		)
	})

	test("Silence on an anomaly incident silences its service and environment, and its badge shows", () => {
		const managed = run(synced(SPIKE), [
			Message.CompletedFetchSession({ grants: Policy.grantsOf(["org:engineer"]) }),
		])
		const opened = pageUpdate(managed, Message.ClickedSilence()).model
		expect(opened.silenceDialog.scope).toEqual({
			_tag: "Fixed",
			label: "Anomaly detection · checkout (production)",
			matchers: { rule_ids: [ruleId(7)], services: ["checkout"], environments: ["production"] },
		})
		const silence = {
			id: Schema.decodeSync(AlertSilenceId)("22222222-2222-4222-8222-222222222222"),
			object: "alert_silence" as const,
			reason: "Checkout deploy",
			matchers: { services: ["checkout"] },
			status: "active" as const,
			starts_at: new Date(NOW - 60_000).toISOString(),
			ends_at: new Date(NOW + 60 * 60_000).toISOString(),
			maintenance_window_id: null,
			created_by: "user_1",
			created_at: new Date(NOW - 60_000).toISOString(),
			updated_at: new Date(NOW - 60_000).toISOString(),
		}
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					managed,
					Message.CompletedFetchSilences({
						key: managed.silences.key ?? "",
						result: Result.succeed([silence]),
					}),
				).model,
			),
			themeResolved(),
			expectView(role("button", { name: "Silence" })).toExist(),
			// The default rule has no scope: the incident's own service is what the silence covers.
			expectView(text(/^Silenced until /u)).toExist(),
		)
	})

	test("the anomaly evidence is read again when its alert incident moves", () => {
		const model = synced(SPIKE)
		const quiet = pageUpdate(
			model,
			Message.UpdatedIncidents({ orgId: ORG, rows: [anomalyIncidentRow(SPIKE)] }),
		)
		expect(names(quiet.commands)).not.toContain("FetchAlertIncidentAnomaly")
		const escalated = pageUpdate(
			model,
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [
					anomalyIncidentRow(SPIKE, {
						last_triggered_at: new Date(NOW + 60_000).toISOString(),
						severity: "warning",
					}),
				],
			}),
		)
		expect(names(escalated.commands)).toEqual(
			expect.arrayContaining(["FetchAlertIncidentAnomaly", "FetchAlertIncidentAnomalyTimeseries"]),
		)
	})
})
