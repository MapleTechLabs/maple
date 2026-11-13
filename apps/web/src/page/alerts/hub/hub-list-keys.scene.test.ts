import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Array as Arr, Schema } from "effect"
import {
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	scene,
	selector,
	Subscription,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import { hubAt, type HubAt, incidentRow, NOW, ORG, ruleRow, stateRow } from "../../kit/alert-test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, ScrollFocusedRow, update } from "./update"
import { view as pageView } from "./view"

// The Inbox's open incidents take the list keys: J / K / arrows step, Enter opens, Escape lets go.

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const incidentId = (n: number) => `0199a003-0000-7000-8000-00000000000${n}`
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

// Inbox order: the critical one, then the warning, then the one held for data.
const CRITICAL = incidentRow({ id: incidentId(1), rule_name: "Payment p95 latency" })
const WARNING = incidentRow({
	id: incidentId(2),
	rule_id: "0199a002-0000-7000-8000-000000000001",
	incident_key: "rule-1:all",
	dedupe_key: "rule-1:all",
	rule_name: "Checkout p95 latency",
	severity: "warning",
})
const HELD = incidentRow({
	id: incidentId(3),
	rule_id: "0199a002-0000-7000-8000-000000000003",
	incident_key: "rule-3:all",
	dedupe_key: "rule-3:all",
	rule_name: "Search p95 latency",
	hold_reason: "no_data",
	held_since: iso(5),
})

const loaded = (at: HubAt = {}, incidents = [HELD, WARNING, CRITICAL]): Model =>
	Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(1), ruleRow(2), ruleRow(3)] }),
			Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(1), stateRow(2), stateRow(3)] }),
			Message.UpdatedIncidents({ orgId: ORG, rows: incidents }),
			Message.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:engineer"]) }),
		],
		init(hubAt(at), context).model,
		(model, message) => pageUpdate(model, message).model,
	)

const press = (key: string) => Subscription.emit(Message.PressedListKey({ key }))
const scrolled = () => Command.resolve(ScrollFocusedRow, Message.CompletedScrollFocusedRow())
const focusedRow = selector("[data-focused]")
const pressed = (model: Model, ...keys: ReadonlyArray<string>): Model =>
	Arr.reduce(keys, model, (next, key) => pageUpdate(next, Message.PressedListKey({ key })).model)

describe("alerts inbox keys", () => {
	test("J and K move the focus through the open incidents in the Inbox's order, and Escape clears it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(focusedRow).toBeAbsent(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Payment p95 latency"),
			press("ArrowDown"),
			scrolled(),
			expectView(focusedRow).toContainText("Checkout p95 latency"),
			press("j"),
			scrolled(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("Search p95 latency"),
			press("k"),
			scrolled(),
			expectView(focusedRow).toContainText("Checkout p95 latency"),
			press("Escape"),
			expectView(focusedRow).toBeAbsent(),
		)
	})

	test("Enter opens the focused incident", () => {
		scene(
			{ update: pageUpdate, view },
			given(pressed(loaded(), "j", "j")),
			press("Enter"),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: `/alerts/incidents/${incidentId(2)}`,
					isReplace: false,
				}),
			),
		)
	})

	test("the focus stays on its incident when a new one lands above it", () => {
		const focused = pressed(loaded({}, [WARNING]), "j")
		const grown = pageUpdate(
			focused,
			Message.UpdatedIncidents({ orgId: ORG, rows: [WARNING, CRITICAL] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(grown),
			expectView(focusedRow).toContainText("Checkout p95 latency"),
			press("k"),
			scrolled(),
			expectView(focusedRow).toContainText("Payment p95 latency"),
		)
	})

	test("another section has no incident rows to step over, and leaving the Inbox drops the focus", () => {
		expect(pressed(loaded({ tab: "rules" }), "j").focusedIncidentId).toBeNull()
		const focused = pressed(loaded(), "j")
		expect(focused.focusedIncidentId).toBe(incidentId(1))
		expect(routeChanged(focused, hubAt({ tab: "rules" }), context).model.focusedIncidentId).toBeNull()
	})
})
