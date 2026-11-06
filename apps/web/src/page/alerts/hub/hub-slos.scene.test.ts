import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, within, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { sloHref } from "../shared/slo-commands"
import { checkoutSlo, SLO_RULE_UUID, searchSlo, sloStatus, sloUuid } from "../shared/slo-test-fixtures"
import { incidentRow, NOW, ORG } from "../shared/test-rows"
import { Message } from "./message"
import type { Model, SloListRow } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const onSlos = (grants = ENGINEER): Model => {
	const entered = init({ _tag: "Alerts", search: { tab: "slos" } }, context).model
	return Arr.reduce(
		[Message.ReadClock({ nowMs: NOW }), Message.CompletedFetchSession({ orgId: ORG, grants })],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

const withSlos = (rows: ReadonlyArray<SloListRow>, model = onSlos()): Model =>
	pageUpdate(model, Message.CompletedFetchSlos({ key: model.slos.key ?? "", result: Result.succeed(rows) }))
		.model

const table = role("table", { name: "SLOs" })

const HEALTHY_AND_BURNING: ReadonlyArray<SloListRow> = [
	{ slo: checkoutSlo(), status: sloStatus("burning") },
	{ slo: searchSlo(), status: sloStatus("healthy", { sloId: sloUuid(2), targetPercent: 99.5 }) },
]

describe("alerts hub, SLOs tab", () => {
	test("the SLOs and their statuses are read only while the tab is open", () => {
		expect(names(init({ _tag: "Alerts", search: {} }, context).commands)).not.toContain(
			"FetchAlertsHubSlos",
		)
		expect(names(init({ _tag: "Alerts", search: { tab: "slos" } }, context).commands)).toContain(
			"FetchAlertsHubSlos",
		)
	})

	test("an org without SLOs is told what one is and offered the first", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSlos([])),
			expectView(text("No SLOs yet")).toExist(),
			expectView(
				text(
					"An SLO sets the share of a service's requests that must succeed or stay fast, and alerts when the error budget burns too fast.",
				),
			).toExist(),
			expectView(role("link", { name: "New SLO" })).toHaveAttr("href", "/alerts/slos/new"),
		)
	})

	test("a member sees the empty tab without a way to create one", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSlos([], onSlos(MEMBER))),
			expectView(text("No SLOs yet")).toExist(),
			expectView(role("link", { name: "New SLO" })).not.toExist(),
		)
	})

	test("each row names the SLO, its indicator and target, and links to its page", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSlos(HEALTHY_AND_BURNING)),
			expectView(within(table, role("link", { name: "Checkout API" }))).toHaveAttr(
				"href",
				sloHref(checkoutSlo().id),
			),
			expectView(within(table, text("checkout · production"))).toExist(),
			expectView(within(table, text("Availability"))).toExist(),
			expectView(within(table, text("99.9% over 30 days"))).toExist(),
			expectView(within(table, text("Latency < 500 ms"))).toExist(),
			expectView(within(table, text("99.5% over 28 days"))).toExist(),
		)
	})

	test("a row reads the SLI, the budget left and the fastest burn off its status", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSlos(HEALTHY_AND_BURNING)),
			// Burning: 12% left, the 5m window at 18.2x is the fastest.
			expectView(within(table, text("12%"))).toExist(),
			expectView(within(table, text("18x"))).toExist(),
			expectView(within(table, role("meter", { name: "12% of the error budget left" }))).toExist(),
			// Healthy: 62% left, the 30m window at 0.6x the fastest.
			expectView(within(table, text("62%"))).toExist(),
			expectView(within(table, text("0.6x"))).toExist(),
		)
	})

	test("the readout counts the SLOs, the burning ones and those out of budget", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withSlos([
					...HEALTHY_AND_BURNING,
					{
						slo: checkoutSlo({ id: sloUuid(3), name: "Payments" }),
						status: sloStatus("exhausted"),
					},
				]),
			),
			expectView(text(/^3\s*SLOs$/u)).toExist(),
			expectView(text(/^1\s*burning$/u)).toExist(),
			expectView(text(/^1\s*out of budget$/u)).toExist(),
		)
	})

	test("alerting reads as on, off, or an open incident on the SLO's rule", () => {
		const withIncident = pageUpdate(
			withSlos(HEALTHY_AND_BURNING),
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [incidentRow({ rule_id: SLO_RULE_UUID, signal_type: "slo_burn_rate", status: "open" })],
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withIncident),
			expectView(within(table, text("Incident open"))).toExist(),
			expectView(within(table, text("Alerting off"))).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withSlos(HEALTHY_AND_BURNING)),
			expectView(within(table, text("Alerting on"))).toExist(),
		)
	})

	test("a row whose status read failed keeps its name and shows no figures", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSlos([{ slo: checkoutSlo(), status: null }])),
			expectView(within(table, role("link", { name: "Checkout API" }))).toExist(),
			expectView(within(table, role("meter"))).not.toExist(),
		)
	})

	test("a failed list read says so with a retry that reads again", () => {
		const model = onSlos()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchSlos({
				key: model.slos.key ?? "",
				result: Result.fail(toLoadFailure(new Error("boom"))),
			}),
		).model
		scene({ update: pageUpdate, view }, given(failed), expectView(text("Couldn't load SLOs")).toExist())
		expect(names(pageUpdate(failed, Message.ClickedRetrySlos()).commands)).toEqual(["FetchAlertsHubSlos"])
	})

	test("the header offers New SLO beside the list, and the New rule menu goes to the SLO form", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSlos(HEALTHY_AND_BURNING)),
			expectView(role("link", { name: "New SLO" })).toHaveAttr("href", "/alerts/slos/new"),
		)
		const picked = pageUpdate(
			withSlos(HEALTHY_AND_BURNING),
			Message.GotNewRuleMenuMessage({
				message: Menu.Message.ClickedItem({ index: 2, item: { kind: "Item", value: "slo" } }),
			}),
		)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/alerts/slos/new", isReplace: false }),
		)
	})
})

describe("alerts hub inbox, SLO incidents", () => {
	test("an org whose only rules are SLOs' sees their open incidents, not the empty state", () => {
		const entered = init({ _tag: "Alerts", search: {} }, context).model
		const model = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedRules({ orgId: ORG, rows: [] }),
				Message.UpdatedIncidents({
					orgId: ORG,
					rows: [
						incidentRow({
							rule_name: "SLO burn: Checkout API",
							signal_type: "slo_burn_rate",
							comparator: "gte",
							threshold: 6,
							last_observed_value: 16.1,
							group_key: "__total__",
						}),
					],
				}),
			],
			entered,
			(current, message) => pageUpdate(current, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("link", { name: "Checkout API is burning its error budget" })).toExist(),
			expectView(text(/__total__/u)).not.toExist(),
		)
	})
})
