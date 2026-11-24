import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { SloPublicId, type V2Slo } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import {
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	selector,
	text,
	within,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { slosTabHref } from "../shared/slo-commands"
import {
	budgetIncidentRow,
	burnIncidentRow,
	checkoutSlo,
	lowTargetSlo,
	SLO_RULE_UUID,
	searchSlo,
	sloHistory,
	sloStatus,
	type SloScenario,
} from "../shared/slo-test-fixtures"
import { destinationRow, incidentRow, NOW, ORG } from "../../kit/alert-test-rows"
import { Message } from "./message"
import type { Model } from "./model"
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
const publicId = Schema.encodeSync(SloPublicId)
const callout = selector('[data-slot="alert"]')
const burnPanel = role("region", { name: "Burn rate" })
const alertingPanel = role("region", { name: "Alerting" })
const incidentsPanel = role("region", { name: "Incidents" })
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const entered = (slo: V2Slo = checkoutSlo()) =>
	init({ _tag: "AlertsSlo", sloId: publicId(slo.id), search: {} }, context)

/** The page with the SLO read, then `extra` (a status, a history, synced rows). */
const opened = (slo: V2Slo, extra: (model: Model) => ReadonlyArray<Message> = () => []): Model => {
	const model = Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER }),
			Message.CompletedFetchSlo({ key: entered(slo).model.slo.key ?? "", result: Result.succeed(slo) }),
		],
		entered(slo).model,
		(current, message) => pageUpdate(current, message).model,
	)
	return Arr.reduce(extra(model), model, (current, message) => pageUpdate(current, message).model)
}

const withStatus = (scenario: SloScenario, slo = checkoutSlo()) =>
	opened(slo, (model) => [
		Message.CompletedFetchStatus({
			key: model.status.key ?? "",
			result: Result.succeed(sloStatus(scenario, { sloId: slo.id, targetPercent: slo.target_percent })),
		}),
		Message.CompletedFetchHistory({
			key: model.history.key ?? "",
			result: Result.succeed(sloHistory(scenario)),
		}),
		Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		Message.UpdatedIncidents({ orgId: ORG, rows: [] }),
	])

describe("SLO page", () => {
	test("entry reads the SLO, its status and its history by the id in the URL", () => {
		expect(names(entered().commands)).toEqual(
			expect.arrayContaining(["FetchSlo", "FetchSloStatus", "FetchSloHistory"]),
		)
	})

	test("an id that is not an SLO's reads nothing and says so", () => {
		const entry = init({ _tag: "AlertsSlo", sloId: "nope", search: {} }, context)
		expect(names(entry.commands)).not.toContain("FetchSlo")
		scene(
			{ update: pageUpdate, view },
			given(entry.model),
			themeResolved(),
			expectView(text("SLO not found")).toExist(),
		)
	})

	test("while the SLO loads the page shows its skeleton, no figures", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered().model),
			themeResolved(),
			expectView(role("heading", { name: "Checkout API" })).not.toExist(),
			expectView(text("Current SLI")).not.toExist(),
		)
	})

	test("a healthy SLO shows its SLI against the target, the budget left and the events counted", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("healthy")),
			themeResolved(),
			expectView(role("heading", { name: "Checkout API" })).toExist(),
			expectView(text("Current SLI")).toExist(),
			expectView(text("99.962%")).toExist(),
			expectView(text("Target 99.9% over 30 days")).toExist(),
			expectView(text("62%")).toExist(),
			expectView(text("1.2M")).toExist(),
			// Nothing burns: no callout, and both tiers are quiet.
			expectView(callout).not.toExist(),
			expectView(within(burnPanel, text("Would fire"))).not.toExist(),
		)
	})

	test("a burning SLO leads with the critical tier, its rates and the incident it opened", () => {
		const incident = incidentRow({ rule_id: SLO_RULE_UUID, signal_type: "slo_burn_rate", status: "open" })
		const model = pageUpdate(
			withStatus("burning"),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incident] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(within(callout, text("Burning the error budget at 16x over 1h"))).toExist(),
			expectView(within(callout, role("link", { name: "Open incident" }))).toHaveAttr(
				"href",
				`/alerts/incidents/${incident.id}`,
			),
			// 1h at 16.1x and 5m at 18.2x both reach 14.4x; 6h at 7.3x and 30m at 9.4x reach 6x.
			expectView(
				within(burnPanel, text("1h at 16x, 5m at 18x. Critical pages when both reach 14.4x.")),
			).toExist(),
			expectView(within(burnPanel, text("Would fire"))).toExist(),
			expectView(within(incidentsPanel, role("link", { name: /Open/u }))).toHaveAttr(
				"href",
				`/alerts/incidents/${incident.id}`,
			),
		)
	})

	test("an outage holds the two fast tiers: the open incident still leads, its severity stays, only the slow tier reads quiet", () => {
		const incident = incidentRow({ rule_id: SLO_RULE_UUID, signal_type: "slo_burn_rate", status: "open" })
		const model = pageUpdate(
			withStatus("holding"),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incident] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(
				within(callout, text("Holding: no events in 5m, an open incident stays open")),
			).toExist(),
			expectView(within(callout, role("link", { name: "Open incident" }))).toHaveAttr(
				"href",
				`/alerts/incidents/${incident.id}`,
			),
			expectView(within(role("heading", { name: /Checkout API/u }), text("Critical"))).toExist(),
			expectView(
				within(burnPanel, text("Holding: no events in 30m, an open incident stays open.")),
			).toExist(),
			// The slow tier's 2h window still holds events, and 24h at 2.4x is under its 3x.
			expectView(
				within(burnPanel, text("24h at 2.4x, 2h at 12x. Warning opens a ticket when both reach 3x.")),
			).toExist(),
			expectView(within(burnPanel, text("Would fire"))).not.toExist(),
		)
	})

	test("the burn panel lists all six windows and the three tiers", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("healthy")),
			themeResolved(),
			expectView(within(burnPanel, text("Last 2h"))).toExist(),
			expectView(within(burnPanel, text("Last 24h"))).toExist(),
			expectView(within(burnPanel, text("14.4x over 1h and 5m"))).toExist(),
			expectView(within(burnPanel, text("6x over 6h and 30m"))).toExist(),
			expectView(within(burnPanel, text("3x over 24h and 2h"))).toExist(),
		)
	})

	test("a burn only the slow tier sees fires it as a warning", () => {
		const incident = burnIncidentRow({ severity: "warning" })
		const model = pageUpdate(
			withStatus("slow"),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incident] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(within(callout, text("Burning the error budget at 3.2x over 24h"))).toExist(),
			expectView(within(role("heading", { name: /Checkout API/u }), text("Warning"))).toExist(),
			expectView(
				within(
					burnPanel,
					text("24h at 3.2x, 2h at 3.5x. Warning opens a ticket when both reach 3x."),
				),
			).toExist(),
			// 1h at 3.8x is far under the page tier's 14.4x, and 6h at 3.9x under the ticket tier's 6x.
			expectView(
				within(burnPanel, text("1h at 3.8x, 5m at 3.4x. Critical pages when both reach 14.4x.")),
			).toExist(),
		)
	})

	test("a low target fires at the burn it can reach, and says what capped it", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("capped", lowTargetSlo())),
			themeResolved(),
			// 1h at 8.3x and 5m at 8.6x: under 14.4x, over the 8x a 90% target is capped at.
			expectView(within(callout, text("Burning the error budget at 8.3x over 1h"))).toExist(),
			expectView(
				within(callout, text(/The critical tier fires at 8x over both 1h and 5m\./u)),
			).toExist(),
			expectView(within(burnPanel, text("8x over 1h and 5m"))).toExist(),
			expectView(within(burnPanel, text("14.4x over 1h and 5m"))).not.toExist(),
			expectView(
				within(
					burnPanel,
					text(
						"1h at 8.3x, 5m at 8.6x. Critical pages when both reach 8x, not 14.4x: a target of 90% can burn at most 10x.",
					),
				),
			).toExist(),
			// 6x and 3x are within reach of a 90% target, so those tiers keep their factors.
			expectView(within(burnPanel, text("6x over 6h and 30m"))).toExist(),
			expectView(within(burnPanel, text("3x over 24h and 2h"))).toExist(),
		)
	})

	test("a tier burning on a handful of events holds as too few to judge, not as no events", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("sparse")),
			themeResolved(),
			expectView(callout).not.toExist(),
			expectView(
				within(
					burnPanel,
					text("Holding: too few events in 1h to judge, an open incident stays open."),
				),
			).toExist(),
			expectView(within(burnPanel, text(/no events in/u))).not.toExist(),
			expectView(within(burnPanel, text("Would fire"))).not.toExist(),
			// One failure in 300 requests overspends the budget on paper: no verdict on that.
			expectView(text("Too few events to judge")).toExist(),
			expectView(text("Error budget spent")).not.toExist(),
		)
		const incident = burnIncidentRow()
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(withStatus("sparse"), Message.UpdatedIncidents({ orgId: ORG, rows: [incident] }))
					.model,
			),
			themeResolved(),
			expectView(
				within(callout, text("Holding: too few events in 1h to judge, an open incident stays open")),
			).toExist(),
			expectView(
				within(callout, text(/needs 10 events and 2 bad ones in 1h to judge the burn/u)),
			).toExist(),
		)
	})

	test("a holding tier without an open incident shows in the burn panel, not as a callout", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("holding")),
			themeResolved(),
			expectView(callout).not.toExist(),
			expectView(
				within(burnPanel, text("Holding: no events in 5m, an open incident stays open.")),
			).toExist(),
		)
	})

	test("a spent budget reads negative and says the SLO is out of budget", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("exhausted")),
			themeResolved(),
			expectView(text("-35%")).toExist(),
			expectView(within(callout, text("Error budget spent"))).toExist(),
			expectView(text("Spent: 35% over budget")).toExist(),
		)
	})

	test("an open budget incident gets its own calm callout, and is not a burn", () => {
		const budget = budgetIncidentRow()
		const model = pageUpdate(
			withStatus("exhausted"),
			Message.UpdatedIncidents({ orgId: ORG, rows: [budget] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(within(callout, text("Error budget spent"))).toExist(),
			expectView(within(callout, role("link", { name: "Open budget incident" }))).toHaveAttr(
				"href",
				`/alerts/incidents/${budget.id}`,
			),
			// Nothing burns: no burn callout, and the header carries no severity.
			expectView(text(/Burning the error budget/u)).not.toExist(),
			expectView(role("link", { name: "Open incident" })).not.toExist(),
			expectView(within(role("heading", { name: /Checkout API/u }), text("Warning"))).not.toExist(),
			expectView(within(incidentsPanel, role("link", { name: /Budget spent/u }))).toHaveAttr(
				"href",
				`/alerts/incidents/${budget.id}`,
			),
		)
	})

	test("a burn and a spent budget open at once each lead with their own incident", () => {
		const burn = burnIncidentRow()
		const budget = budgetIncidentRow()
		const model = pageUpdate(
			withStatus("spent-burning"),
			// The budget incident synced first: the burn callout must still link the burn incident.
			Message.UpdatedIncidents({ orgId: ORG, rows: [budget, burn] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Burning the error budget at 16x over 1h")).toExist(),
			expectView(role("link", { name: "Open incident" })).toHaveAttr(
				"href",
				`/alerts/incidents/${burn.id}`,
			),
			expectView(text("Error budget spent")).toExist(),
			expectView(role("link", { name: "Open budget incident" })).toHaveAttr(
				"href",
				`/alerts/incidents/${budget.id}`,
			),
			// The header's severity is the burn's, not the budget warning's.
			expectView(within(role("heading", { name: /Checkout API/u }), text("Critical"))).toExist(),
		)
	})

	test("an SLO that counted no events reads No data, never a full budget", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("no-data", checkoutSlo({ environments: ["prod"] }))),
			themeResolved(),
			expectView(text("No data")).toExist(),
			expectView(text("100%")).not.toExist(),
			expectView(text("Of the 30-day budget")).not.toExist(),
			expectView(within(callout, text("No events in the last 30 days"))).toExist(),
			expectView(
				within(callout, text(/environments are free text, so prod does not match production/u)),
			).toExist(),
		)
	})

	test("a budget spent to exactly zero reads fully spent, not 0% over budget", () => {
		const zero = opened(checkoutSlo(), (model) => [
			Message.CompletedFetchStatus({
				key: model.status.key ?? "",
				result: Result.succeed({ ...sloStatus("exhausted"), budget_remaining: 0 }),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(zero),
			themeResolved(),
			expectView(text("Fully spent")).toExist(),
			expectView(text("0% over budget")).not.toExist(),
		)
	})

	test("a window that counted no events says so instead of drawing empty charts", () => {
		const history = sloHistory("healthy")
		const quiet = opened(checkoutSlo(), (model) => [
			Message.CompletedFetchStatus({
				key: model.status.key ?? "",
				result: Result.succeed(sloStatus("healthy")),
			}),
			Message.CompletedFetchHistory({
				key: model.history.key ?? "",
				result: Result.succeed({
					...history,
					points: Arr.map(history.points, (point) => ({
						...point,
						sli: null,
						budget_remaining: 1,
						burn_rate: 0,
					})),
				}),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(quiet),
			themeResolved(),
			expectView(within(role("region", { name: "SLI" }), text("No events in this window"))).toExist(),
			expectView(
				within(role("region", { name: "Error budget" }), text("No events in this window")),
			).toExist(),
		)
	})

	test("a failed history read names its own chart in each panel", () => {
		const failed = opened(checkoutSlo(), (model) => [
			Message.CompletedFetchStatus({
				key: model.status.key ?? "",
				result: Result.succeed(sloStatus("healthy")),
			}),
			Message.CompletedFetchHistory({
				key: model.history.key ?? "",
				result: Result.fail(toLoadFailure(new Error("warehouse down"))),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(
				within(role("region", { name: "Error budget" }), text("Couldn't load the budget history")),
			).toExist(),
			expectView(
				within(role("region", { name: "SLI" }), text("Couldn't load the SLI history")),
			).toExist(),
		)
	})

	test("a failed status read says so in place of the figures, with a retry that reads it again", () => {
		const failed = opened(checkoutSlo(), (model) => [
			Message.CompletedFetchStatus({
				key: model.status.key ?? "",
				result: Result.fail(toLoadFailure(new Error("warehouse down"))),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(role("heading", { name: "Checkout API" })).toExist(),
			expectView(text("Couldn't read the SLO's status")).toExist(),
			expectView(text("Current SLI")).not.toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryStatus()).commands)).toEqual(["FetchSloStatus"])
	})

	test("incidents that never sync say live sync is unavailable, and Retry reconnects", () => {
		const waiting = opened(checkoutSlo(), (model) => [
			Message.CompletedFetchStatus({
				key: model.status.key ?? "",
				result: Result.succeed(sloStatus("healthy")),
			}),
		])
		const failed = pageUpdate(waiting, Message.FailedLoadIncidents({ orgId: ORG })).model
		scene(
			{ update: pageUpdate, view },
			given(waiting),
			themeResolved(),
			expectView(within(incidentsPanel, text("Couldn't load incidents"))).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(within(incidentsPanel, text("Couldn't load incidents"))).toExist(),
			expectView(within(incidentsPanel, text("Live sync is unavailable."))).toExist(),
		)
		expect(pageUpdate(failed, Message.ClickedRetryIncidents()).outMessage).toEqual(
			PageOutMessage.RequestedReconnectOrgCollections(),
		)
		// Rows that arrive late replace the failure; a failure after rows changes nothing.
		const synced = pageUpdate(failed, Message.UpdatedIncidents({ orgId: ORG, rows: [] })).model
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(synced, Message.FailedLoadIncidents({ orgId: ORG })).model),
			themeResolved(),
			expectView(within(incidentsPanel, text("No incidents yet"))).toExist(),
			expectView(within(incidentsPanel, text("Couldn't load incidents"))).not.toExist(),
		)
	})

	test("a window that counted one event says 1 event", () => {
		const status = sloStatus("healthy")
		const one = opened(checkoutSlo(), (model) => [
			Message.CompletedFetchStatus({
				key: model.status.key ?? "",
				result: Result.succeed({
					...status,
					burn_windows: Arr.map(status.burn_windows, (entry) =>
						entry.window_minutes === 5 ? { ...entry, total_events: 1 } : entry,
					),
				}),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(one),
			themeResolved(),
			expectView(within(burnPanel, text("1 event"))).toExist(),
			expectView(within(burnPanel, text("1 events"))).not.toExist(),
		)
	})

	test("the description scrolls with the body, out of the pinned header", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("healthy")),
			themeResolved(),
			expectView(
				within(selector('[data-slot="page-scroll-area"]'), text("Checkout requests succeed.")),
			).toExist(),
			expectView(
				within(selector('[data-slot="page-sticky-area"]'), text("Checkout requests succeed.")),
			).not.toExist(),
		)
	})

	test("alerting lists who each tier notifies, and is said to be off when it is", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus("healthy")),
			themeResolved(),
			expectView(within(alertingPanel, text("On-call webhook"))).toExist(),
			expectView(
				within(alertingPanel, text("Nobody, the incident still opens in the inbox")),
			).toExist(),
			expectView(within(alertingPanel, role("switch", { name: "Burn-rate alerting" }))).toHaveAttr(
				"aria-checked",
				"true",
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(withStatus("healthy", searchSlo())),
			themeResolved(),
			expectView(
				within(
					alertingPanel,
					text("Burn-rate alerts are off: no incident opens however fast the budget burns"),
				),
			).toExist(),
		)
	})

	test("the alerting switch PATCHes once and takes the saved SLO", () => {
		const model = withStatus("healthy")
		const toggling = pageUpdate(model, Message.ClickedToggleAlerting())
		expect(toggling.commands).toMatchObject([{ name: "ToggleSloAlerting", args: { enabled: false } }])
		expect(pageUpdate(toggling.model, Message.ClickedToggleAlerting()).commands ?? []).toEqual([])
		const saved = checkoutSlo({
			alerting: { enabled: false, critical_destination_ids: [], warning_destination_ids: [] },
		})
		const done = pageUpdate(
			toggling.model,
			Message.CompletedToggleAlerting({ result: Result.succeed(saved) }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Alerting turned off", description: "" }),
		)
		scene(
			{ update: pageUpdate, view },
			given(done.model),
			themeResolved(),
			expectView(within(alertingPanel, role("switch", { name: "Burn-rate alerting" }))).toHaveAttr(
				"aria-checked",
				"false",
			),
		)
	})

	test("Delete confirms, deletes once and goes back to the SLOs tab", () => {
		const asking = pageUpdate(withStatus("healthy"), Message.ClickedDelete())
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDelete())
		expect(names(deleting.commands)).toEqual(["DeleteSlo"])
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDelete()).commands ?? []).toEqual([])
		const done = pageUpdate(
			deleting.model,
			Message.CompletedDelete({ result: Result.succeed(undefined) }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: slosTabHref(),
				isReplace: true,
				toast: { type: "success", title: "SLO deleted", description: "" },
			}),
		)
	})

	test("a member sees edit, delete and the alerting switch locked, with who can use them", () => {
		const member = pageUpdate(
			withStatus("healthy"),
			Message.CompletedFetchSession({ orgId: ORG, grants: MEMBER }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(member),
			themeResolved(),
			expectView(role("link", { name: "Edit" })).not.toExist(),
			expectView(role("button", { name: "Edit" })).toBeDisabled(),
			expectView(role("button", { name: "Delete" })).toBeDisabled(),
			expectView(role("group", { name: "Only org admins and engineers can manage alerts." })).toExist(),
			expectView(within(alertingPanel, role("switch", { name: "Burn-rate alerting" }))).toHaveAttr(
				"aria-disabled",
				"true",
			),
		)
	})
})
