import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { CreateInvestigation } from "./command"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { incidentRow, INCIDENT_ID, NOW, ORG, ruleRow, stateRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const route = (incidentId = INCIDENT_ID) => ({ _tag: "AlertIncident" as const, incidentId, search: {} })

const step = (model: Model, message: Message) => pageUpdate(model, message)

describe("alert incident", () => {
	test("entry reads the clock and loads the chart runtime; the incident's reads follow its row", () => {
		const entered = init(route(), context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ReadAlertIncidentClock", "LoadChartRuntime"]),
		)
		const clocked = step(entered.model, Message.ReadClock({ nowMs: NOW })).model
		const withIncident = step(clocked, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(names(withIncident.commands)).toEqual(
			expect.arrayContaining(["FetchAlertIncidentDeliveries", "FetchAlertIncidentInvestigation"]),
		)
		const withRule = step(withIncident.model, Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }))
		expect(names(withRule.commands)).toEqual(["FetchAlertIncidentPreview"])
		const again = step(withRule.model, Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2)] }))
		expect(again.commands ?? []).toHaveLength(0)
	})

	test("an uptime incident asks for no rule preview and says what its signal is", () => {
		const entered = init(route(), context).model
		const uptimeIncident = incidentRow({ signal_type: "uptime", rule_name: "Checkout health" })
		const loaded = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [uptimeIncident] }),
		].reduce((model, message) => step(model, message).model, entered)
		const withRule = step(
			loaded,
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { signal_type: "uptime" })] }),
		)
		expect(names(withRule.commands)).not.toContain("FetchAlertIncidentPreview")
		scene(
			{ update: pageUpdate, view },
			given(withRule.model),
			themeResolved(),
			expectView(text("resolves when one passes again", { exact: false })).toExist(),
		)
	})

	test("a failed delivery read is not refetched when the live rows change", () => {
		const entered = init(route(), context).model
		const loaded = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
		].reduce((model, message) => step(model, message).model, entered)
		const failed = step(
			loaded,
			Message.CompletedFetchDeliveries({
				key: loaded.deliveries.key ?? "",
				result: Result.fail(toLoadFailure(new Error("x"))),
			}),
		).model
		const updated = step(failed, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(updated.commands ?? []).toHaveLength(0)
		scene(
			{ update: pageUpdate, view },
			given(updated.model),
			themeResolved(),
			expectView(text("Couldn't load delivery history, so notifications are missing.")).toExist(),
		)
	})

	test("a changed incident row re-reads the clock, so Open Xm and the preview window move on", () => {
		const loaded = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
		].reduce((model, message) => step(model, message).model, init(route(), context).model)
		const changed = step(
			loaded,
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow({ last_observed_value: 2100 })] }),
		)
		expect(names(changed.commands)).toContain("ReadAlertIncidentClock")
		const later = step(changed.model, Message.ReadClock({ nowMs: NOW + 10 * 60_000 + 30_000 }))
		expect(later.model.nowMs).toBe(NOW + 10 * 60_000)
		expect(names(later.commands)).toContain("FetchAlertIncidentPreview")
		scene(
			{ update: pageUpdate, view },
			given(later.model),
			themeResolved(),
			expectView(text(/^Open 2h ·/)).toExist(),
		)
	})

	test("an uptime incident's header names the monitor and never the ungrouped key", () => {
		const uptime = incidentRow({
			rule_name: "checkout-api",
			signal_type: "uptime",
			comparator: "gte",
			threshold: 1,
			last_observed_value: 1,
			group_key: "__total__",
		})
		const loaded = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [uptime] }),
		].reduce((model, message) => step(model, message).model, init(route(), context).model)
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(role("heading", { name: "checkout-api is down" })).toExist(),
			expectView(text(/__total__/u)).not.toExist(),
		)
	})

	test("an unknown incident says so and links back to alerts", () => {
		const model = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [] }),
		].reduce((current, message) => step(current, message).model, init(route("missing"), context).model)
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Incident not found")).toExist(),
			expectView(role("link", { name: "Back to alerts" })).toHaveAttr("href", "/alerts"),
		)
	})

	test("Investigate opens one investigation and navigates to it", () => {
		const loaded = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
		].reduce((model, message) => step(model, message).model, init(route(), context).model)
		const answered = step(
			loaded,
			Message.CompletedFetchInvestigation({
				key: loaded.investigation.key ?? "",
				result: Result.succeed(null),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(answered),
			themeResolved(),
			click(role("button", { name: "Investigate" })),
			expectView(role("button", { name: "Investigate" })).toBeDisabled(),
			Command.resolve(
				CreateInvestigation,
				Message.CompletedCreateInvestigation({ result: Result.succeed("inv-1") }),
			),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/investigations/inv-1", isReplace: false }),
			),
		)
		const started = step(answered, Message.ClickedInvestigate())
		expect(names(started.commands)).toEqual(["CreateAlertInvestigation"])
		expect(step(started.model, Message.ClickedInvestigate()).commands ?? []).toHaveLength(0)
		const done = step(
			started.model,
			Message.CompletedCreateInvestigation({ result: Result.succeed("inv-1") }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/investigations/inv-1", isReplace: false }),
		)
	})
})
