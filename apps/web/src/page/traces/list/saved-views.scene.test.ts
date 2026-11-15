import { OrgId } from "@maple/domain"
import * as Dialog from "@maple/views/ui/dialog"
import { Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as SavedViews from "../../kit/saved-views"
import { navigationOf, savedView, sentNamed, viewsDriver } from "../../kit/saved-views/test-views"
import type { Search } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { viewsExplorer } from "./saved-views"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const toViews = (message: SavedViews.Message) => Message.GotSavedViewsMessage({ message })
const views = viewsDriver((model: Model, message) => pageUpdate(model, toViews(message)))

const SLOW_CHECKOUT: Search = {
	services: ["checkout"],
	minDurationMs: 500,
	sortBy: "durationMs",
	sortDir: "desc",
	timePreset: "6h",
}
const SLOW = savedView("traces", "0a", "Slow checkout", {
	search: {
		services: ["checkout"],
		minDurationMs: 500,
		sortBy: "durationMs",
		sortDir: "desc",
		timePreset: "6h",
	},
})
const FAILING = savedView("traces", "0b", "Failing requests", {
	search: { hasError: true, rootOnly: true },
})

/** The page entered on `search` and windowed, with the saved views it lists. */
const entered = (search: Search, listed: ReadonlyArray<SavedViews.SavedView>): Model =>
	views.listed(
		pageUpdate(
			init({ search }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
		).model,
		listed,
	)

/** A dialog on screen, open or still leaving. */
const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

describe("traces saved views", () => {
	test("entry reads the saved views of the traces explorer", () => {
		expect(sentNamed(init({ search: {} }, context).commands, "FetchSavedViews")).toEqual([
			{ name: "FetchSavedViews", args: { surface: "traces", revision: 0 } },
		])
	})

	test("saving stores the filters, the sort and the relative window", () => {
		const saved = views.saveAs(entered(SLOW_CHECKOUT, []), "Slow checkout")
		expect(sentNamed(saved.commands, "CreateSavedView")).toEqual([
			{
				name: "CreateSavedView",
				args: {
					surface: "traces",
					name: "Slow checkout",
					state: {
						search: {
							services: ["checkout"],
							minDurationMs: 500,
							sortBy: "durationMs",
							sortDir: "desc",
							timePreset: "6h",
						},
					},
					visibility: "private",
				},
			},
		])
	})

	test("an open peek sheet is not part of the view it is saved from", () => {
		const peeking: Search = { ...SLOW_CHECKOUT, peek: "trace0001", peekRow: "3", peekSpan: "span9" }
		const saved = views.saveAs(entered(peeking, []), "Slow checkout")
		expect(sentNamed(saved.commands, "CreateSavedView")[0]?.args).toEqual({
			surface: "traces",
			name: "Slow checkout",
			state: SLOW.state,
			visibility: "private",
		})
	})

	test("the toolbar names the view this URL is, with or without a peek open", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered(SLOW_CHECKOUT, [SLOW, FAILING])),
			expectView(role("button", { name: "Slow checkout" })).toExist(),
			expectView(text("Edited")).not.toExist(),
		)
		const peeking = routeChanged(
			entered(SLOW_CHECKOUT, [SLOW, FAILING]),
			{ search: { ...SLOW_CHECKOUT, peek: "trace0001" } },
			context,
		).model
		expect(SavedViews.activeViewOf(peeking.savedViews, viewsExplorer([peeking.search]))).toMatchObject({
			view: { name: "Slow checkout" },
			isModified: false,
		})
	})

	test("picking a view goes to its params", () => {
		expect(navigationOf(views.open(entered({}, [SLOW, FAILING]), FAILING).outMessage)).toEqual({
			url: "/traces?hasError=true&rootOnly=true",
			isReplace: false,
		})
	})

	test("a filter changed after opening a view reads Edited, and Update view stores the new params", () => {
		const opened = views.open(entered(SLOW_CHECKOUT, [SLOW]), SLOW).model
		const edited = routeChanged(
			opened,
			{ search: { ...SLOW_CHECKOUT, minDurationMs: 1000 } },
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(edited),
			expectView(role("button", { name: /Slow checkout\s*Edited/ })).toExist(),
		)
		expect(sentNamed(views.update(edited).commands, "UpdateSavedViewState")[0]?.args).toEqual({
			viewId: SLOW.id,
			state: { search: { ...SLOW.state.search, minDurationMs: 1000 } },
		})
	})

	test("a renamed view shows its new name in the toolbar", () => {
		scene(
			{ update: pageUpdate, view },
			given(views.renamed(entered(SLOW_CHECKOUT, [SLOW]), SLOW, "Slow checkout p99")),
			dialogMounted,
			expectView(role("button", { name: "Slow checkout p99" })).toExist(),
		)
	})

	test("deleting the page's view returns the toolbar to Views", () => {
		const deleting = views.confirmDelete(entered(SLOW_CHECKOUT, [SLOW]))
		expect(sentNamed(deleting.commands, "DeleteSavedView")).toEqual([
			{ name: "DeleteSavedView", args: { viewId: SLOW.id } },
		])
		scene(
			{ update: pageUpdate, view },
			given(views.deleted(deleting.model, SLOW)),
			dialogMounted,
			expectView(role("button", { name: "Views" })).toExist(),
		)
	})

	test("opening a view replaces the duration draft and drops its pending commit", () => {
		const SLOW = savedView("traces", "0c", "Slow requests", {
			search: { minDurationMs: 500, timePreset: "1h" },
		})
		const typed = pageUpdate(
			entered({ minDurationMs: 500, timePreset: "1h" }, [SLOW]),
			Message.ChangedDurationDraft({ min: "2s", max: "" }),
		).model
		const opened = views.open(typed, SLOW)
		expect(opened.model.durationDraft.min).not.toBe("2s")
		// The commit the old draft scheduled fires after the view opened: it must not navigate.
		expect(
			pageUpdate(opened.model, Message.ElapsedDurationDebounce({ version: typed.durationDraftVersion }))
				.outMessage,
		).toBeUndefined()
	})
})
