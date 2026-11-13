import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import type { PageContext } from "../../contract"
import { hubAt, type HubAt, incidentRow, NOW, ORG, ruleRow, stateRow } from "../../kit/alert-test-rows"
import { anomalyIncidentRow, scopedAnomalyRuleRow } from "../shared/anomaly-test-fixtures"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An observer reads the Inbox; acknowledging an incident from its row needs `incidents:respond`.

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const MEMBER = Policy.grantsOf(["org:member"])
const OBSERVER = Policy.grantsOf(["org:observer"])

const ACKNOWLEDGED = incidentRow({
	id: "0199a003-0000-7000-8000-000000000002",
	rule_name: "Payment p95 latency",
	group_key: "checkout",
	acknowledged_at: new Date(NOW - 60_000).toISOString(),
	acknowledged_by_name: "Dana Kim",
	acknowledged_via: "slack",
})

/** One firing and one acknowledged incident, plus an open anomaly, read by `grants`. */
const loaded = (grants: ReadonlyArray<Policy.Permission>, at: HubAt = {}): Model =>
	Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedRules({
				orgId: ORG,
				rows: [ruleRow(2, { name: "Payment p95 latency" }), scopedAnomalyRuleRow()],
			}),
			Message.UpdatedRuleStates({
				orgId: ORG,
				rows: [stateRow(2, { last_status: "breached", last_value: 1840 })],
			}),
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [
					incidentRow({ rule_name: "Payment p95 latency" }),
					ACKNOWLEDGED,
					anomalyIncidentRow({
						n: 1,
						ruleN: 8,
						severity: "critical",
						service: "checkout",
						environment: "production",
					}),
				],
			}),
			Message.CompletedFetchSession({ orgId: ORG, grants }),
		],
		init(hubAt(at), context).model,
		(model, message) => pageUpdate(model, message).model,
	)

describe("alerts inbox, observer", () => {
	test("an observer reads the open incidents and gets no acknowledge button on a row", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(OBSERVER)),
			expectView(text(/1 acknowledged/)).toExist(),
			expectView(text(/^Acknowledged by Dana Kim ·/)).toExist(),
			expectView(role("button", { name: /^Acknowledge / })).toBeAbsent(),
			expectView(role("button", { name: /^Unacknowledge / })).toBeAbsent(),
		)
	})

	test("a member gets a button to flip each row's acknowledgement", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER)),
			expectView(role("button", { name: /^Unacknowledge / })).toExist(),
		)
	})

	test("the Anomalies view offers Acknowledge to a member and not to an observer", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(OBSERVER, { signal: "anomaly" })),
			expectView(text(/^1 firing/)).toExist(),
			expectView(role("button", { name: /^Acknowledge / })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER, { signal: "anomaly" })),
			expectView(role("button", { name: /^Acknowledge / })).toExist(),
		)
	})
})
