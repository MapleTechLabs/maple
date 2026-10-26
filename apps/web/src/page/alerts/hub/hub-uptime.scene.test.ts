import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import * as Animation from "@foldkit/ui/animation"
import {
	click,
	Command,
	expect as expectView,
	Mount,
	given,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as Menu from "../../../ui/menu"
import { MountMenu } from "../../../ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { incidentRow, NOW, ORG } from "../shared/test-rows"
import { monitorHref } from "../shared/uptime-commands"
import type { UptimeMonitor } from "../shared/uptime-derive"
import { downMonitor, httpMonitor, pausedMonitor } from "../shared/uptime-test-monitors"
import { Message } from "./message"
import type { Model } from "./model"
import { init, monitorMenuId, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const onUptime = (): Model => {
	const entered = init({ _tag: "Alerts", search: { tab: "uptime" } }, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchSession({ orgId: ORG, isAdmin: true }),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

const withMonitors = (monitors: ReadonlyArray<UptimeMonitor>): Model => {
	const model = onUptime()
	return pageUpdate(
		model,
		Message.CompletedFetchMonitors({ key: model.monitors.key ?? "", result: Result.succeed(monitors) }),
	).model
}

const THREE = [httpMonitor(), downMonitor(), pausedMonitor()]

describe("alerts hub inbox, uptime incidents", () => {
	test("an uptime incident reads as its monitor being down, without the ungrouped key", () => {
		const entered = init({ _tag: "Alerts", search: {} }, context).model
		const model = [
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedRules({ orgId: ORG, rows: [] }),
			Message.UpdatedIncidents({
				orgId: ORG,
				rows: [
					incidentRow({
						rule_name: "checkout-api",
						signal_type: "uptime",
						comparator: "gte",
						threshold: 1,
						last_observed_value: 1,
						group_key: "__total__",
					}),
				],
			}),
		].reduce((current, message) => pageUpdate(current, message).model, entered)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("link", { name: "checkout-api is down" })).toExist(),
			expectView(text(/__total__/u)).not.toExist(),
			expectView(text("Down / Down")).not.toExist(),
		)
	})
})

describe("alerts hub, Uptime tab", () => {
	test("the monitors are read only when the Uptime tab is open", () => {
		expect(names(init({ _tag: "Alerts", search: {} }, context).commands)).not.toContain(
			"FetchAlertsHubMonitors",
		)
		expect(names(init({ _tag: "Alerts", search: { tab: "uptime" } }, context).commands)).toContain(
			"FetchAlertsHubMonitors",
		)
	})

	test("a populated tab sums the monitors and links each row to its page", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors(THREE)),
			expectView(text("1 up · 1 down · 1 paused")).toExist(),
			expectView(text("payments-api for 6m")).toExist(),
			expectView(text("Down 6m")).toExist(),
			expectView(text("Paused")).toExist(),
			expectView(role("link", { name: "payments-api" })).toHaveAttr(
				"href",
				monitorHref(downMonitor().id),
			),
		)
	})

	test("an org without monitors is told what uptime checks are and offered the first one", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors([])),
			expectView(text("No uptime checks yet")).toExist(),
			expectView(role("link", { name: "New uptime check" })).toHaveAttr("href", "/alerts/uptime/new"),
		)
	})

	test("a failed list read says so with a retry that reads again", () => {
		const model = onUptime()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchMonitors({
				key: model.monitors.key ?? "",
				result: Result.fail(toLoadFailure(new Error("boom"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load monitors")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryMonitors()).commands)).toEqual([
			"FetchAlertsHubMonitors",
		])
	})

	test("the Down segment keeps only the monitors that are down", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors(THREE)),
			click(role("button", { name: "Down 1" })),
			expectView(role("link", { name: "payments-api" })).toExist(),
			expectView(role("link", { name: "checkout-api" })).not.toExist(),
			expectView(role("link", { name: "legacy-api" })).not.toExist(),
		)
	})

	test("Pause from a row menu PATCHes once and re-reads the list when it lands", () => {
		const model = withMonitors(THREE)
		const target = httpMonitor()
		const menuId = monitorMenuId(target.id)
		const pausing = pageUpdate(
			model,
			Message.GotRowMenuMessage({
				menuId,
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: "toggle" } }),
			}),
		)
		expect(names(pausing.commands)).toContain("ToggleUptimeMonitor")
		const done = pageUpdate(
			pausing.model,
			Message.CompletedToggleMonitor({
				monitorId: target.id,
				result: Result.succeed({ ...target, enabled: false }),
			}),
		)
		expect(names(done.commands)).toEqual(["FetchAlertsHubMonitors"])
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Monitor paused", description: "" }),
		)
	})

	test("the New rule chevron opens both kinds, and Uptime check goes to the uptime form", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors(THREE)),
			click(role("button", { name: "More rule types" })),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			Mount.resolve(MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(text("Check a URL, port, DNS record or cron job from outside.")).toExist(),
			expectView(text("Error rate, latency or any query on traces, logs and metrics.")).toExist(),
		)
		const picked = pageUpdate(
			withMonitors(THREE),
			Message.GotNewRuleMenuMessage({
				message: Menu.Message.ClickedItem({ index: 1, item: { kind: "Item", value: "uptime" } }),
			}),
		)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/alerts/uptime/new", isReplace: false }),
		)
	})
})
