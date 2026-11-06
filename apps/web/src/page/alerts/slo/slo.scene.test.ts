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
	checkoutSlo,
	SLO_RULE_UUID,
	searchSlo,
	sloHistory,
	sloStatus,
	type SloScenario,
} from "../shared/slo-test-fixtures"
import { destinationRow, incidentRow, NOW, ORG } from "../shared/test-rows"
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
			result: Result.succeed(sloStatus(scenario)),
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

	test("an outage holds both tiers: the open incident still leads, its severity stays, nothing reads quiet", () => {
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
			expectView(within(burnPanel, text("Quiet"))).not.toExist(),
			expectView(within(burnPanel, text("Would fire"))).not.toExist(),
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
					text("Burn-rate alerts are off: no incident opens however fast the budget burns."),
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

	test("a member sees the SLO without edit or delete, and the switch only shows the state", () => {
		const member = pageUpdate(
			withStatus("healthy"),
			Message.CompletedFetchSession({ orgId: ORG, grants: MEMBER }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(member),
			themeResolved(),
			expectView(role("link", { name: "Edit" })).not.toExist(),
			expectView(role("button", { name: "Delete" })).not.toExist(),
			expectView(within(alertingPanel, role("switch", { name: "Burn-rate alerting" }))).toHaveAttr(
				"aria-disabled",
				"true",
			),
		)
	})
})
