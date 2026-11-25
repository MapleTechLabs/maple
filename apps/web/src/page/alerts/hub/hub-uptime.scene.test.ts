import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
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
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { MountMenu } from "@maple/views/ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { hubAt, incidentRow, NOW, ORG } from "../../kit/alert-test-rows"
import { monitorHref } from "../../kit/uptime/commands"
import type { UptimeMonitor } from "../../kit/uptime/derive"
import { downMonitor, httpMonitor, monitorId, pausedMonitor } from "../../kit/uptime/test-monitors"
import { Message } from "./message"
import type { Model } from "./model"
import { init, monitorMenuId, update } from "./update"
import { view as pageView } from "./view"

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])
/** Custom roles: uptime checks without alert rules, and alert rules without uptime checks. */
const UPTIME_ONLY: ReadonlyArray<Policy.Permission> = ["telemetry:read", "uptime_monitors:manage"]
const ALERTS_ONLY: ReadonlyArray<Policy.Permission> = ["telemetry:read", "alerts:manage"]

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const onUptime = (): Model => {
	const entered = init(hubAt({ tab: "uptime" }), context).model
	return Arr.reduce(
		[Message.ReadClock({ nowMs: NOW }), Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER })],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

const withMonitors = (monitors: ReadonlyArray<UptimeMonitor>): Model => {
	const model = onUptime()
	return pageUpdate(
		model,
		Message.CompletedFetchMonitors({ key: model.monitors.key ?? "", result: Result.succeed(monitors) }),
	).model
}

const THREE = [httpMonitor(), downMonitor(), pausedMonitor()]

const withNamespaces = (model: Model, namespaces: Record<string, string>): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchServiceNamespaces({
			key: model.serviceNamespaces.key ?? "",
			result: Result.succeed(namespaces),
		}),
	).model

const GROUPED = [
	httpMonitor(),
	downMonitor({ service_name: "payments-api" }),
	httpMonitor({ id: monitorId(4), name: "cron-heartbeat", service_name: null }),
]
const NAMESPACES = { "checkout-api": "shop", "payments-api": "billing" }

describe("alerts hub inbox, uptime incidents", () => {
	test("an uptime incident reads as its monitor being down, without the ungrouped key", () => {
		const entered = init(hubAt(), context).model
		const model = Arr.reduce(
			[
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
			],
			entered,
			(current, message) => pageUpdate(current, message).model,
		)
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
	test("a row's subline names the type and the target, and drops a target the name repeats", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withMonitors([
					httpMonitor(),
					httpMonitor({ id: monitorId(5), name: "api.acme.dev/checkout/health" }),
				]),
			),
			expectView(text("HTTP · api.acme.dev/checkout/health")).toExist(),
			// The second row's subline is the type alone; there is no Type column to match instead.
			expectView(text("HTTP")).toExist(),
		)
	})

	test("the monitors are read only when the Uptime tab is open", () => {
		expect(names(init(hubAt(), context).commands)).not.toContain("FetchAlertsHubMonitors")
		expect(names(init(hubAt({ tab: "uptime" }), context).commands)).toContain("FetchAlertsHubMonitors")
	})

	test("opening the tab also reads which namespace each service reports under", () => {
		expect(names(init(hubAt({ tab: "uptime" }), context).commands)).toContain(
			"FetchAlertsHubServiceNamespaces",
		)
	})

	test("monitors sit under their service's namespace, unlinked ones under No namespace", () => {
		scene(
			{ update: pageUpdate, view },
			given(withNamespaces(withMonitors(GROUPED), NAMESPACES)),
			expectView(text("shop")).toExist(),
			expectView(text("billing")).toExist(),
			expectView(text("No namespace")).toExist(),
			expectView(role("link", { name: "cron-heartbeat" })).toExist(),
		)
	})

	test("without namespaces the list has no group headers", () => {
		scene(
			{ update: pageUpdate, view },
			given(withNamespaces(withMonitors(GROUPED), {})),
			expectView(text("No namespace")).not.toExist(),
			expectView(role("link", { name: "checkout-api" })).toExist(),
		)
	})

	test("a pinned namespace lists only its own monitors, without a header", () => {
		const pinned: PageContext = { ...context, pinnedNamespace: "billing" }
		const pinnedUpdate = (model: Model, message: Message) => update(model, message, pinned)
		scene(
			{ update: pinnedUpdate, view: withViewInputs(pageView, { context: pinned })() },
			given(withNamespaces(withMonitors(GROUPED), NAMESPACES)),
			expectView(role("link", { name: "payments-api" })).toExist(),
			expectView(role("link", { name: "checkout-api" })).not.toExist(),
			expectView(role("link", { name: "cron-heartbeat" })).not.toExist(),
			expectView(text("No namespace")).not.toExist(),
		)
	})

	test("a populated tab sums the monitors and links each row to its page", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors(THREE)),
			expectView(text(/^3\s*monitors$/)).toExist(),
			expectView(text(/^1\s*down$/)).toExist(),
			expectView(text("Down 6m")).toExist(),
			expectView(text("Paused")).toExist(),
			expectView(role("link", { name: "payments-api" })).toHaveAttr(
				"href",
				monitorHref(downMonitor().id),
			),
		)
	})

	test("each row reads P50, P95 and P99 off its recent checks", () => {
		// Recent durations 100 to 139 ms: nearest rank lands on 119, 137 and 139.
		scene(
			{ update: pageUpdate, view },
			given(withMonitors([httpMonitor()])),
			expectView(text("119 ms")).toExist(),
			expectView(text("137 ms")).toExist(),
			expectView(text("139 ms")).toExist(),
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

	test("a member sees monitors with create, edit, pause and delete locked", () => {
		const asMember = (model: Model) =>
			pageUpdate(model, Message.CompletedFetchSession({ orgId: ORG, grants: MEMBER })).model
		scene(
			{ update: pageUpdate, view },
			given(asMember(withMonitors([]))),
			expectView(text("No uptime checks yet")).toExist(),
			expectView(role("link", { name: "New uptime check" })).not.toExist(),
			expectView(role("button", { name: "New uptime check" })).toBeDisabled(),
			expectView(role("group", { name: Policy.denialFor("uptime_monitors:manage").message })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(asMember(withMonitors(THREE))),
			// The row menu stays, its items disabled with who can use them.
			expectView(role("button", { name: `Actions for ${httpMonitor().name}` })).toExist(),
		)
	})

	test("a custom role with only uptime_monitors:manage creates, edits and deletes monitors", () => {
		const asUptimeOnly = (model: Model) =>
			pageUpdate(model, Message.CompletedFetchSession({ orgId: ORG, grants: UPTIME_ONLY })).model
		scene(
			{ update: pageUpdate, view },
			given(asUptimeOnly(withMonitors([]))),
			expectView(role("link", { name: "New uptime check" })).toHaveAttr("href", "/alerts/uptime/new"),
		)
		const listed = asUptimeOnly(withMonitors(THREE))
		const menuId = monitorMenuId(httpMonitor().id)
		scene(
			{ update: pageUpdate, view },
			given({ ...listed, menus: { ...listed.menus, [menuId]: Menu.init(menuId, { isOpen: true }) } }),
			Mount.resolve(MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("link", { name: "New monitor" })).toHaveAttr("href", "/alerts/uptime/new"),
			expectView(role("menuitem", { name: "Edit" })).not.toHaveAttr("aria-disabled", "true"),
			expectView(role("menuitem", { name: "Delete" })).not.toHaveAttr("aria-disabled", "true"),
		)
		// The Inbox's New rule menu offers it too, and keeps alert rules locked.
		const inbox = { ...listed, tab: "inbox" as const }
		scene(
			{ update: pageUpdate, view },
			given({ ...inbox, newRuleMenu: Menu.init(inbox.newRuleMenu.id, { isOpen: true }) }),
			Mount.resolve(MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: /Uptime check/ })).not.toHaveAttr("aria-disabled", "true"),
			expectView(role("menuitem", { name: /SLO/ })).toHaveAttr("aria-disabled", "true"),
		)
	})

	test("alerts:manage alone does not unlock uptime checks", () => {
		const asAlertsOnly = (model: Model) =>
			pageUpdate(model, Message.CompletedFetchSession({ orgId: ORG, grants: ALERTS_ONLY })).model
		scene(
			{ update: pageUpdate, view },
			given(asAlertsOnly(withMonitors([]))),
			expectView(role("link", { name: "New uptime check" })).not.toExist(),
			expectView(role("group", { name: Policy.denialFor("uptime_monitors:manage").message })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(asAlertsOnly(withMonitors(THREE))),
			expectView(role("link", { name: "New monitor" })).not.toExist(),
			expectView(role("button", { name: "New monitor" })).toBeDisabled(),
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

	test("Clear filters on an empty result resets the query, status and type", () => {
		const filtered = Arr.reduce(
			[
				Message.ChangedUptimeQuery({ value: "nothing-matches" }),
				Message.ClickedUptimeStatus({ filter: "down" }),
				Message.ChangedUptimeKind({ kind: "tcp" }),
			],
			withMonitors(THREE),
			(model, message) => pageUpdate(model, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(filtered),
			click(role("button", { name: "Clear filters" })),
			expectView(role("link", { name: "payments-api" })).toExist(),
			expectView(role("link", { name: "checkout-api" })).toExist(),
			expectView(role("link", { name: "legacy-api" })).toExist(),
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

	test("Delete from a row menu confirms, deletes that monitor once and re-reads the list", () => {
		const target = downMonitor()
		const asking = pageUpdate(
			withMonitors(THREE),
			Message.GotRowMenuMessage({
				menuId: monitorMenuId(target.id),
				message: Menu.Message.ClickedItem({ index: 2, item: { kind: "Item", value: "delete" } }),
			}),
		)
		expect(asking.model.confirmDeleteMonitorId).toBe(target.id)
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeleteMonitor())
		expect(deleting.commands).toMatchObject([
			{ name: "DeleteUptimeMonitor", args: { monitorId: target.id } },
		])
		// A second confirm while the first is in flight sends nothing.
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDeleteMonitor()).commands ?? []).toEqual([])

		const done = pageUpdate(
			deleting.model,
			Message.CompletedDeleteMonitor({ monitorId: target.id, result: Result.succeed(undefined) }),
		)
		expect(names(done.commands)).toContain("FetchAlertsHubMonitors")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Monitor deleted", description: "" }),
		)
		expect(done.model.deletingMonitorId).toBeNull()
	})

	test("the header's one primary action is New monitor here, for admins only", () => {
		scene(
			{ update: pageUpdate, view },
			given(withMonitors(THREE)),
			expectView(role("link", { name: "New monitor" })).toHaveAttr("href", "/alerts/uptime/new"),
			expectView(role("link", { name: "New rule" })).not.toExist(),
			expectView(role("button", { name: "More rule types" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...withMonitors(THREE), search: { serviceName: "checkout-api" } }),
			expectView(role("link", { name: "New monitor" })).toHaveAttr(
				"href",
				"/alerts/uptime/new?serviceName=checkout-api",
			),
		)
		// The empty state offers the first check itself, so the header stays empty.
		scene(
			{ update: pageUpdate, view },
			given(withMonitors([])),
			expectView(role("link", { name: "New monitor" })).not.toExist(),
			expectView(role("link", { name: "New uptime check" })).toExist(),
		)
		const asMember = pageUpdate(
			withMonitors(THREE),
			Message.CompletedFetchSession({ orgId: ORG, grants: MEMBER }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(asMember),
			expectView(role("link", { name: "New monitor" })).not.toExist(),
			expectView(role("link", { name: "New rule" })).not.toExist(),
		)
	})

	test("on the Inbox the New rule chevron opens every kind, and Uptime check goes to the uptime form", () => {
		scene(
			{ update: pageUpdate, view },
			given({ ...withMonitors(THREE), tab: "inbox" as const }),
			expectView(role("link", { name: "New rule" })).toHaveAttr("href", "/alerts/create"),
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
