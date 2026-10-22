import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Menu from "../../../ui/menu"
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
	messages.reduce((current, message) => pageUpdate(current, message).model, model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

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
			expectView(text("Couldn’t load dashboards")).toExist(),
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

	test("a failed create toasts as well as raising the banner", () => {
		const creating = pageUpdate(listed(), Message.ClickedCreate())
		expect(names(creating.commands)).toEqual([CreateDashboard.name])
		const failed = pageUpdate(
			creating.model,
			Message.CompletedCreateDashboard({ result: Result.fail("Failed to create dashboard") }),
		)
		expect(failed.model.persistenceError).toBe("Failed to create dashboard")
		expect(failed.outMessage?._tag).toBe("RequestedToast")
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
				result: Result.succeed({ id: "dash_new", name: "Perses", isPerses: true, warnings }),
			}),
		)
		const out = imported.outMessage
		expect(out?._tag === "RequestedNavigation" && out.followUpToast).toEqual({
			type: "warning",
			title: "Imported with 4 warnings",
			description: "a\nb\nc\n+1 more",
		})
	})
})
