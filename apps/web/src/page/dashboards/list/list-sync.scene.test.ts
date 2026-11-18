import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { CreateDashboard, FetchDashboardsFallback } from "./command"
import { Message } from "./message"
import type { ListDashboard, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, isReadOnly, rowMenuIdOf, update } from "./update"
import { view as pageView } from "./view"

// A live list that never answers, and the list's write feedback.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const board: ListDashboard = {
	id: "dash_platform",
	name: "Platform overview",
	description: null,
	tags: [],
	widgetCount: 2,
	readsShort: "Traces",
	readsFull: "Traces",
	glyph: "PulseIcon",
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
}

const waiting = (): Model =>
	run(init({ search: {} }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z"), locale: "en-US" }),
		Message.CompletedLoadPreferences({ favorites: [], sort: "updated" }),
	])

const timedOut = () => pageUpdate(waiting(), Message.TimedOutLiveDashboards({ orgId }))
const degraded = () =>
	pageUpdate(timedOut().model, Message.CompletedFetchFallback({ orgId, result: Result.succeed([board]) }))
		.model

describe("dashboards list when live sync is down", () => {
	test("a live list still loading arms the watchdog; a timeout reads the snapshot and reconnects", () => {
		const watched = (model: Model) =>
			subscriptions.loadWatchdog.modelToDependencies({ model, context }).orgId
		expect(watched(waiting())).toBe(orgId)
		expect(names(timedOut().commands)).toEqual([FetchDashboardsFallback.name])
		expect(timedOut().outMessage).toEqual(PageOutMessage.RequestedReconnectOrgCollections())
		expect(watched(timedOut().model)).toBeNull()
	})

	test("the snapshot renders read-only under the degraded banner", () => {
		expect(isReadOnly(degraded())).toBe(true)
		expect(names(pageUpdate(degraded(), Message.ClickedCreate()).commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(degraded()),
			expectView(text("Platform overview")).toExist(),
			expectView(role("button", { name: "Retry sync" })).toExist(),
		)
	})

	test("live rows win over the snapshot", () => {
		const live = pageUpdate(degraded(), Message.UpdatedDashboards({ orgId, dashboards: [] })).model
		expect(isReadOnly(live)).toBe(false)
	})

	test("neither live nor snapshot shows the load error with a retry", () => {
		const failed = pageUpdate(
			timedOut().model,
			Message.CompletedFetchFallback({ orgId, result: Result.fail("down") }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load dashboards")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		const retried = pageUpdate(failed, Message.ClickedRetrySync())
		expect(retried.outMessage).toEqual(PageOutMessage.RequestedReconnectOrgCollections())
		expect(retried.model.fallback._tag).toBe("Idle")
	})

	test("a read-only row menu disables its writes and says why", () => {
		const open = {
			...degraded(),
			rowMenuId: board.id,
			rowMenu: Menu.init(rowMenuIdOf(board.id), { isOpen: true }),
		}
		scene(
			{ update: pageUpdate, view },
			given(open),
			Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu()),
			expectView(role("menuitem", { name: "Duplicate" })).toHaveAttr("aria-disabled", "true"),
			expectView(text("Dashboard store unreachable, writes are disabled")).toExist(),
		)
	})
})

describe("dashboards list write feedback", () => {
	const listed = () =>
		pageUpdate(waiting(), Message.UpdatedDashboards({ orgId, dashboards: [board] })).model

	test("a failed create raises the banner without a second toast", () => {
		const creating = pageUpdate(listed(), Message.ClickedCreate())
		expect(names(creating.commands)).toEqual([CreateDashboard.name])
		const failed = pageUpdate(
			creating.model,
			Message.CompletedCreateDashboard({
				result: Result.fail({ message: "Couldn't create dashboard", isRejected: false }),
			}),
		)
		expect(failed.model.persistenceError).toBe("Couldn't create dashboard")
		expect(failed.outMessage).toBeUndefined()
	})

	test("a failed write while the list is still loading reads the snapshot instead of waiting", () => {
		const failed = pageUpdate(
			waiting(),
			Message.CompletedCreateDashboard({
				result: Result.fail({ message: "Failed to fetch", isRejected: false }),
			}),
		)
		expect(names(failed.commands)).toEqual([FetchDashboardsFallback.name])
		const unreachable = pageUpdate(
			failed.model,
			Message.CompletedFetchFallback({ orgId, result: Result.fail("Failed to fetch") }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(unreachable),
			expectView(text("Couldn't load dashboards")).toExist(),
		)
	})

	test("a delete whose sync-back timed out says the tab is behind", () => {
		const behind = pageUpdate(
			listed(),
			Message.CompletedDeleteDashboard({ result: Result.succeed("Behind") }),
		)
		expect(behind.outMessage?._tag === "RequestedToast" && behind.outMessage.title).toBe(
			"Saved, but this tab is behind",
		)
	})

	test("a Perses import with warnings follows the success toast with the first three", () => {
		const warnings = ["a", "b", "c", "d"]
		const imported = pageUpdate(
			listed(),
			Message.CompletedImportDashboard({
				result: Result.succeed({
					id: "dash_new",
					name: "Perses",
					importedFrom: "perses",
					warnings,
					stats: null,
				}),
			}),
		)
		const out = imported.outMessage
		expect(out?._tag === "RequestedNavigation" && out.followUpToast).toEqual({
			type: "warning",
			title: "Imported with 4 warnings",
			description: "a\nb\nc\n+1 more",
		})
	})

	test("a Grafana import with warnings stays on the list and reports them in a dialog", () => {
		const warnings = [
			'Panel "Error logs" queries Loki, which Maple cannot run; it was imported as a placeholder.',
		]
		const imported = pageUpdate(
			listed(),
			Message.CompletedImportDashboard({
				result: Result.succeed({
					id: "dash_grafana",
					name: "Node overview",
					importedFrom: "grafana",
					warnings,
					stats: { panels: 7, converted: 6 },
				}),
			}),
		)
		expect(imported.outMessage).toBeUndefined()
		scene(
			{ update: pageUpdate, view },
			given(imported.model),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("alertdialog", { name: "Imported “Node overview”" })).toExist(),
			expectView(
				text(
					"6 of 7 panels converted. 1 panel Maple cannot run yet became a note that keeps its original queries.",
				),
			).toExist(),
			expectView(text(warnings[0] ?? "")).toExist(),
			expectView(role("button", { name: "Open dashboard" })).toExist(),
		)
		const opened = pageUpdate(imported.model, Message.ClickedOpenImportedDashboard())
		expect(opened.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/dashboards/dash_grafana", isReplace: false }),
		)
		// Closing the report forgets it: the warnings were read in the dialog.
		const closed = pageUpdate(
			imported.model,
			Message.GotImportReportDialogMessage({ message: Dialog.Message.ClickedClose() }),
		)
		expect(closed.model.importReport).toBeNull()
	})

	test("a clean Grafana import opens the dashboard with a toast naming Grafana", () => {
		const imported = pageUpdate(
			listed(),
			Message.CompletedImportDashboard({
				result: Result.succeed({
					id: "dash_grafana",
					name: "Node overview",
					importedFrom: "grafana",
					warnings: [],
					stats: { panels: 3, converted: 3 },
				}),
			}),
		)
		const out = imported.outMessage
		expect(out?._tag === "RequestedNavigation" && out.toast?.title).toBe(
			'Dashboard "Node overview" imported from Grafana',
		)
	})

	test("a refused write toasts and leaves the list writable", () => {
		const creating = pageUpdate(listed(), Message.ClickedCreate()).model
		const refused = pageUpdate(
			creating,
			Message.CompletedCreateDashboard({
				result: Result.fail({
					message: "A dashboard with this name already exists",
					isRejected: true,
				}),
			}),
		)
		expect(refused.outMessage?._tag).toBe("RequestedToast")
		expect(isReadOnly(refused.model)).toBe(false)
		expect(names(pageUpdate(refused.model, Message.ClickedCreate()).commands)).toEqual([
			CreateDashboard.name,
		])
	})

	test("Retry sync and the next healthy sync turn writes back on after a failed write", () => {
		const failed = pageUpdate(
			listed(),
			Message.CompletedCreateDashboard({
				result: Result.fail({ message: "Failed to fetch", isRejected: false }),
			}),
		).model
		expect(isReadOnly(failed)).toBe(true)
		expect(isReadOnly(pageUpdate(failed, Message.ClickedRetrySync()).model)).toBe(false)
		const whileDown = pageUpdate(
			listed(),
			Message.CompletedCreateDashboard({
				result: Result.fail({ message: "Failed to fetch", isRejected: false }),
			}),
		).model
		const recovered = pageUpdate(
			whileDown,
			Message.UpdatedDashboards({ orgId, dashboards: [board] }),
		).model
		expect(isReadOnly(recovered)).toBe(false)
	})

	test("a failed export is reported", () => {
		expect(
			pageUpdate(
				listed(),
				Message.CompletedExportDashboard({ error: "Dashboard sync was not confirmed" }),
			).outMessage?._tag,
		).toBe("RequestedToast")
		expect(
			pageUpdate(listed(), Message.CompletedExportDashboard({ error: null })).outMessage,
		).toBeUndefined()
	})
})
