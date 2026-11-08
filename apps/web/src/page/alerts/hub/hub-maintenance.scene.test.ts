import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import type { V2AlertMaintenanceWindow, V2AlertSilence } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import * as Menu from "@maple/views/ui/menu"
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
import { PageOutMessage, type PageContext } from "../../contract"
import { alertsHref } from "../shared/links"
import {
	disabledWindow,
	endedWindow,
	populatedWindows,
	runningWindow,
	silenceOf,
	silencesWithWindows,
	weeklyWindow,
} from "../shared/maintenance-test-fixtures"
import { windowPublicId, windowSilencesHref } from "../shared/maintenance-windows"
import { NOW, ORG, ruleRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update, windowMenuId } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const ENGINEER = Policy.grantsOf(["org:engineer"])
/** The running window's next occurrence, written ahead and not yet started. */
const scheduledWindowSilence = silenceOf(5, {
	reason: "Maintenance: Checkout v3 migration (part 2)",
	startMin: 120,
	endMin: 180,
	window: runningWindow,
})
const MEMBER = Policy.grantsOf(["org:member"])
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const onTab = (
	search: Model["search"],
	options: Readonly<{
		grants?: ReturnType<typeof Policy.grantsOf>
		windows: ReadonlyArray<V2AlertMaintenanceWindow>
		silences?: ReadonlyArray<V2AlertSilence>
	}>,
): Model => {
	const entered = init({ _tag: "Alerts", search }, context)
	const loaded = Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchSession({ orgId: ORG, grants: options.grants ?? ENGINEER }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(1, { name: "Checkout error rate" })] }),
			Message.CompletedFetchWindows({
				key: entered.model.windows.key ?? "",
				result: Result.succeed(options.windows),
			}),
		],
		entered.model,
		(model, message) => pageUpdate(model, message).model,
	)
	return options.silences === undefined
		? loaded
		: pageUpdate(
				loaded,
				Message.CompletedFetchSilences({
					key: loaded.silences.key ?? "",
					result: Result.succeed(options.silences),
				}),
			).model
}

const onMaintenance = (windows: ReadonlyArray<V2AlertMaintenanceWindow>, grants = ENGINEER) =>
	onTab({ tab: "maintenance" }, { windows, grants })

describe("alerts hub, Maintenance tab", () => {
	test("reads the windows only while the Maintenance or Silences tab is open", () => {
		const fetched = (tab: string) => names(init({ _tag: "Alerts", search: { tab } }, context).commands)
		expect(fetched("maintenance")).toContain("FetchAlertsHubMaintenanceWindows")
		expect(fetched("silences")).toContain("FetchAlertsHubMaintenanceWindows")
		expect(fetched("rules")).not.toContain("FetchAlertsHubMaintenanceWindows")
	})

	test("lists weekly, running, disabled and ended windows with their schedule and next run", () => {
		scene(
			{ update: pageUpdate, view },
			given(onMaintenance(populatedWindows)),
			expectView(text("Nightly database backup")).toExist(),
			expectView(text(/^Weekly, Mon and Thu at .+ for 2h \(Europe\/Berlin\)$/u)).toExist(),
			expectView(
				text(/^service checkout · service payments · env production · Next Oct 5, /u),
			).toExist(),
			expectView(text("Checkout v3 migration")).toExist(),
			expectView(text("Running")).toExist(),
			expectView(text(/^rule Checkout error rate · env production · Running until /u)).toExist(),
			expectView(text(/^Once, Sep 25, .+ to Sep 25, /u)).toExist(),
			expectView(text("tag infra · No more occurrences")).toExist(),
			expectView(text("tag db · Disabled")).toExist(),
			expectView(role("switch", { name: "Enable Weekend reindex" })).toExist(),
		)
	})

	test("an ended one-off window says so and offers no switch to turn it on", () => {
		scene(
			{ update: pageUpdate, view },
			given(onMaintenance([endedWindow, weeklyWindow])),
			expectView(text("Ended")).toExist(),
			expectView(role("switch", { name: "Disable Datacenter move" })).toHaveAttr(
				"aria-disabled",
				"true",
			),
			expectView(role("switch", { name: "Disable Nightly database backup" })).not.toHaveAttr(
				"aria-disabled",
			),
		)
	})

	test("a window change on the Maintenance tab makes the Silences tab read its silences again", () => {
		const model = onTab({ tab: "silences" }, { windows: [weeklyWindow], silences: silencesWithWindows })
		const onMaint = update(model, Message.ReadClock({ nowMs: NOW }), context).model
		const moved = routeChanged(onMaint, { _tag: "Alerts", search: { tab: "maintenance" } }, context).model
		const toggled = pageUpdate(moved, Message.ClickedToggleWindow({ windowId: weeklyWindow.id })).model
		const settled = pageUpdate(
			toggled,
			Message.CompletedToggleWindow({
				windowId: weeklyWindow.id,
				result: Result.succeed({ ...weeklyWindow, enabled: false }),
			}),
		).model
		// Following the row's Occurrences link lands on the Silences tab filtered to the window.
		const back = routeChanged(
			settled,
			{ _tag: "Alerts", search: { tab: "silences", window: windowPublicId(weeklyWindow.id) } },
			context,
		)
		expect(back.commands ?? []).toContainEqual(
			expect.objectContaining({
				name: "FetchAlertsHubSilences",
				args: expect.objectContaining({ windowId: weeklyWindow.id }),
			}),
		)
		const unfiltered = routeChanged(settled, { _tag: "Alerts", search: { tab: "silences" } }, context)
		expect(names(unfiltered.commands)).toContain("FetchAlertsHubSilences")
	})

	test("marks only windows whose baseline exclusion applies", () => {
		scene(
			{ update: pageUpdate, view },
			given(onMaintenance([weeklyWindow])),
			expectView(text("Excluded from baselines")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				onMaintenance([
					{ ...weeklyWindow, matchers: { tags: ["db"] }, exclude_from_baselines: true },
				]),
			),
			expectView(text("Excluded from baselines")).not.toExist(),
		)
	})

	test("an org without windows explains them and offers the first one", () => {
		scene(
			{ update: pageUpdate, view },
			given(onMaintenance([])),
			expectView(text("No maintenance windows")).toExist(),
			expectView(role("button", { name: "Create window" })).toExist(),
			expectView(role("button", { name: "New window" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(onMaintenance([], MEMBER)),
			expectView(role("button", { name: "Create window" })).not.toExist(),
		)
	})

	test("the switch sends one update that flips the window", () => {
		const model = onMaintenance([weeklyWindow])
		const step = pageUpdate(model, Message.ClickedToggleWindow({ windowId: weeklyWindow.id }))
		expect(step.commands ?? []).toEqual([
			expect.objectContaining({
				name: "ToggleMaintenanceWindow",
				args: { windowId: weeklyWindow.id, enabled: false },
			}),
		])
		expect(
			pageUpdate(step.model, Message.ClickedToggleWindow({ windowId: weeklyWindow.id })).commands ?? [],
		).toEqual([])
		const settled = pageUpdate(
			step.model,
			Message.CompletedToggleWindow({
				windowId: weeklyWindow.id,
				result: Result.succeed({ ...weeklyWindow, enabled: false }),
			}),
		)
		expect(settled.outMessage).toMatchObject({ title: "Maintenance window disabled" })
		expect(names(settled.commands)).toContain("FetchAlertsHubMaintenanceWindows")
	})

	test("delete asks first, then sends the delete once", () => {
		const menuId = windowMenuId(endedWindow.id)
		const picked = pageUpdate(
			onMaintenance([endedWindow]),
			Message.GotRowMenuMessage({
				menuId,
				message: Menu.Message.ClickedItem({ index: 2, item: { kind: "Item", value: "delete" } }),
			}),
		)
		expect(picked.model.confirmDeleteWindowId).toBe(endedWindow.id)
		expect(names(picked.commands)).not.toContain("DeleteMaintenanceWindow")
		const confirmed = pageUpdate(picked.model, Message.ClickedConfirmDeleteWindow())
		expect(names(confirmed.commands)).toEqual(["DeleteMaintenanceWindow"])
		expect(names(pageUpdate(confirmed.model, Message.ClickedConfirmDeleteWindow()).commands)).toEqual([])
		const deleted = pageUpdate(
			confirmed.model,
			Message.CompletedDeleteWindow({ windowId: endedWindow.id, result: Result.void }),
		)
		expect(deleted.outMessage).toMatchObject({ title: "Maintenance window deleted" })
		expect(deleted.model.confirmDeleteWindowId).toBeNull()
	})

	test("each window links to its occurrences on the Silences tab", () => {
		scene(
			{ update: pageUpdate, view },
			given(onMaintenance([weeklyWindow])),
			expectView(role("link", { name: "Occurrences" })).toHaveAttr(
				"href",
				windowSilencesHref(weeklyWindow.id),
			),
		)
		expect(windowSilencesHref(weeklyWindow.id)).toContain(`window=${windowPublicId(weeklyWindow.id)}`)
	})

	test("New window opens the dialog, but only once the clock is read", () => {
		const step = pageUpdate(onMaintenance([weeklyWindow]), Message.ClickedNewWindow())
		expect(step.model.windowDialog.dialog.isOpen).toBe(true)
		expect(names(step.commands)).toContain("ReadMaintenanceWindowZones")
		const early = init({ _tag: "Alerts", search: { tab: "maintenance" } }, context).model
		expect(pageUpdate(early, Message.ClickedNewWindow()).model.windowDialog.dialog.isOpen).toBe(false)
	})
})

describe("alerts hub, Silences tab with maintenance windows", () => {
	test("filters to one window's silences and shows a removable chip naming it", () => {
		const model = onTab(
			{ tab: "silences", window: windowPublicId(weeklyWindow.id) },
			{ windows: populatedWindows, silences: silencesWithWindows },
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Window: Nightly database backup")).toExist(),
			expectView(text("Maintenance: Nightly database backup (Snapshot and vacuum)")).toExist(),
			expectView(text("Deploying payments v2.3")).not.toExist(),
			expectView(text("Maintenance: Checkout v3 migration")).not.toExist(),
			click(role("button", { name: "Remove Window: Nightly database backup" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: alertsHref({ tab: "silences" }),
					isReplace: false,
				}),
			),
		)
		// The route without the param reads every silence and drops the chip.
		const cleared = routeChanged(model, { _tag: "Alerts", search: { tab: "silences" } }, context)
		const fetch = Arr.findFirst(cleared.commands ?? [], ({ name }) => name === "FetchAlertsHubSilences")
		expect(fetch).toMatchObject({ value: { args: { windowId: null } } })
		const shown = pageUpdate(
			cleared.model,
			Message.CompletedFetchSilences({
				key: cleared.model.silences.key ?? "",
				result: Result.succeed(silencesWithWindows),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(shown),
			expectView(text(/^Window: /u)).not.toExist(),
			expectView(text("Deploying payments v2.3")).toExist(),
			expectView(text("Maintenance: Checkout v3 migration")).toExist(),
		)
	})

	test("a window's silences say which window manages them and offer no end or cancel", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				onTab(
					{ tab: "silences" },
					{ windows: populatedWindows, silences: [...silencesWithWindows, scheduledWindowSilence] },
				),
			),
			expectView(text("Managed by Checkout v3 migration")).toExist(),
			// The scheduled occurrence is listed but offers no Cancel; the manual silence still ends.
			expectView(text("Maintenance: Checkout v3 migration (part 2)")).toExist(),
			expectView(role("button", { name: "End now" })).toExist(),
			expectView(role("button", { name: "Cancel" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				onTab(
					{ tab: "silences", window: windowPublicId(runningWindow.id) },
					{ windows: populatedWindows, silences: silencesWithWindows },
				),
			),
			expectView(text("Managed by Checkout v3 migration")).toExist(),
			expectView(role("button", { name: "End now" })).not.toExist(),
		)
	})

	test("a window with no occurrences written yet says so", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				onTab(
					{ tab: "silences", window: windowPublicId(disabledWindow.id) },
					{ windows: populatedWindows, silences: silencesWithWindows },
				),
			),
			expectView(text("Window: Weekend reindex")).toExist(),
			expectView(text("No occurrences listed")).toExist(),
		)
	})
})
