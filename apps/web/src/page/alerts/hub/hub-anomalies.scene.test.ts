import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertRuleId } from "@maple/domain/http"
import { UNTAGGED_KEY } from "@maple/web-data/alerts/tag-grouping"
import { Schema, Array as Arr } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Menu from "@maple/views/ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import {
	anomalyIncidentRow,
	defaultAnomalyRuleRow,
	scopedAnomalyRuleRow,
} from "../shared/anomaly-test-fixtures"
import { destinationRow, incidentRow, NOW, ORG, ruleId, ruleRow, stateRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, ruleMenuId, update } from "./update"
import { view as pageView } from "./view"

const ENGINEER = Policy.grantsOf(["org:engineer"])
const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const OPEN_CHECKOUT = anomalyIncidentRow({
	n: 1,
	ruleN: 8,
	severity: "critical",
	service: "checkout",
	environment: "production",
})
const OPEN_SEARCH = anomalyIncidentRow({
	n: 2,
	ruleN: 7,
	severity: "warning",
	service: "search",
	environment: "production",
})
const RESOLVED_CHECKOUT = anomalyIncidentRow({
	n: 3,
	ruleN: 8,
	severity: "warning",
	service: "checkout",
	environment: "staging",
	status: "resolved",
})

const loaded = (
	search: Model["search"],
	incidents = [
		incidentRow({ rule_name: "Payment p95 latency" }),
		OPEN_CHECKOUT,
		OPEN_SEARCH,
		RESOLVED_CHECKOUT,
	],
): Model =>
	Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedRules({
				orgId: ORG,
				rows: [
					ruleRow(2, { name: "Payment p95 latency" }),
					defaultAnomalyRuleRow(),
					scopedAnomalyRuleRow(),
				],
			}),
			Message.UpdatedRuleStates({
				orgId: ORG,
				rows: [
					stateRow(2, { last_status: "breached", last_value: 1840 }),
					stateRow(7, { last_value: 1 }),
				],
			}),
			Message.UpdatedIncidents({ orgId: ORG, rows: incidents }),
			Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
		],
		init({ _tag: "Alerts", search }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

describe("alerts hub: anomalies", () => {
	test("the Anomalies filter lists anomaly incidents alone, and turning it off drops its status and service", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({})),
			expectView(text("Payment p95 latency")).toExist(),
			click(role("button", { name: /^Anomalies/ })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/alerts?tab=inbox&signal=anomaly",
					isReplace: false,
				}),
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly", serviceName: "checkout", anomalyStatus: "all" })),
			click(role("button", { name: /^Anomalies/ })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ url: "/alerts", isReplace: false })),
		)
	})

	test("the anomaly view shows open anomalies by their group, without other rules' incidents", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly" })),
			expectView(text("2 firing")).toExist(),
			expectView(role("link", { name: "Anomaly on checkout (production)" })).toExist(),
			expectView(role("link", { name: "Anomaly on search (production)" })).toExist(),
			expectView(role("link", { name: "Payment p95 latency" })).not.toExist(),
			// The severity is the whole reading: no threshold, no dash placeholder.
			expectView(text("Critical")).toExist(),
			expectView(text(/^ \/ /)).not.toExist(),
			// Resolved anomalies wait behind the status switch.
			expectView(role("link", { name: "Anomaly on checkout (staging)" })).not.toExist(),
		)
	})

	test("a service and the resolved status narrow the view, as the old anomalies links did", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly", serviceName: "checkout", anomalyStatus: "resolved" })),
			expectView(role("link", { name: "Anomaly on checkout (staging)" })).toExist(),
			expectView(role("link", { name: "Anomaly on checkout (production)" })).not.toExist(),
			// The hub holds 30 days of incidents, and the heading says so.
			expectView(text("Resolved in the last 30 days")).toExist(),
			expectView(role("link", { name: "Anomaly on search (production)" })).not.toExist(),
			click(role("button", { name: "Remove checkout" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/alerts?signal=anomaly&anomalyStatus=resolved",
					isReplace: false,
				}),
			),
		)
	})

	test("with no anomalies the view says what the detector watches", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly" }, [incidentRow({ rule_name: "Payment p95 latency" })])),
			expectView(text("No anomalies")).toExist(),
			expectView(text(/^Maple watches error rate, latency, throughput/)).toExist(),
		)
	})

	test("narrowed to a service, the chip counts and the empty state speak for that service", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly", serviceName: "checkout" })),
			expectView(role("button", { name: /^Anomalies\s*1$/ })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly", serviceName: "payments" })),
			expectView(text(/on payments, and opens an anomaly/)).toExist(),
			expectView(text(/every service/)).not.toExist(),
		)
	})

	test("with only resolved anomalies the open view still says there are none", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly" }, [RESOLVED_CHECKOUT])),
			expectView(text("No anomalies")).toExist(),
			expectView(text(/^No rule fired/)).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly", anomalyStatus: "all" }, [RESOLVED_CHECKOUT])),
			expectView(role("link", { name: "Anomaly on checkout (staging)" })).toExist(),
			expectView(text(/^No rule fired/)).not.toExist(),
		)
	})

	test("the rules list marks the default anomaly rule, reads scopes, and offers no way to turn it off", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "rules" })),
			expectView(text("Default")).toExist(),
			expectView(text("Anomaly · all services · all environments · all signals")).toExist(),
			expectView(text("Anomaly · checkout · production · Error rate, p95 latency")).toExist(),
			expectView(text("Warning anomaly open")).toExist(),
		)
		const model = loaded({ tab: "rules" })
		const toggle = (n: number) =>
			pageUpdate(
				model,
				Message.GotRowMenuMessage({
					menuId: ruleMenuId(Schema.decodeSync(AlertRuleId)(ruleId(n)), UNTAGGED_KEY),
					message: Menu.Message.ClickedItem({ index: 1, item: { kind: "Item", value: "toggle" } }),
				}),
			)
		// A scoped anomaly rule turns off like any rule; the default one does not.
		expect(toggle(8).model.togglingRuleId).toBe(ruleId(8))
		expect(toggle(7).model.togglingRuleId).toBeNull()
	})

	test("an unrouted default anomaly rule is normal; an unrouted scoped one is a blind spot", () => {
		const withScoped = (rows: Parameters<typeof Message.UpdatedRules>[0]["rows"]) =>
			Arr.reduce(
				[
					Message.UpdatedRules({ orgId: ORG, rows }),
					Message.UpdatedRuleStates({
						orgId: ORG,
						rows: [stateRow(7, { last_value: 0 }), stateRow(9, { last_value: 0 })],
					}),
				],
				loaded({}),
				(model, message) => pageUpdate(model, message).model,
			)
		scene(
			{ update: pageUpdate, view },
			given(withScoped([defaultAnomalyRuleRow()])),
			expectView(text("Unrouted")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				withScoped([
					defaultAnomalyRuleRow(),
					scopedAnomalyRuleRow(8),
					{
						...scopedAnomalyRuleRow(9),
						name: "Search anomalies",
						thresholds_json: null,
						destination_ids_json: [],
					},
				]),
			),
			expectView(text("Unrouted")).toExist(),
			expectView(text("Search anomalies")).toExist(),
		)
	})

	test("leaving the Inbox drops the Anomalies view's filters from the tab links", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ signal: "anomaly", anomalyStatus: "resolved", serviceName: "checkout" })),
			expectView(role("link", { name: /^Rules/ })).toHaveAttr(
				"href",
				"/alerts?tab=rules&serviceName=checkout",
			),
			expectView(role("link", { name: /^Inbox/ })).toHaveAttr(
				"href",
				"/alerts?tab=inbox&serviceName=checkout&signal=anomaly&anomalyStatus=resolved",
			),
		)
	})
})
