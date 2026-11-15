import { OrgId } from "@maple/domain"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as SavedViews from "../../kit/saved-views"
import { navigationOf, savedView, sentNamed, viewsDriver } from "../../kit/saved-views/test-views"
import { MountFilterRail } from "./command"
import type { Search } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
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

const ERRORS_LAST_HOUR: Search = { severities: ["ERROR"], services: ["checkout"], timePreset: "1h" }
const ERRORS = savedView("logs", "0a", "Checkout errors", {
	search: { severities: ["ERROR"], services: ["checkout"], timePreset: "1h" },
})
const WARNINGS = savedView("logs", "0b", "Warnings today", {
	search: { severities: ["WARN"], timePreset: "24h" },
})

/** The page entered on `search` and windowed, with the saved views it lists. */
const entered = (search: Search, listed: ReadonlyArray<SavedViews.SavedView>): Model =>
	views.listed(
		pageUpdate(
			pageUpdate(
				init({ search }, context).model,
				Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
			).model,
			Message.MountedFilterRail(),
		).model,
		listed,
	)

const pageMounts = [
	Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
]
/** A dialog on screen, open or still leaving. */
const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

describe("logs saved views", () => {
	test("entry reads the saved views of the logs explorer", () => {
		expect(sentNamed(init({ search: {} }, context).commands, "FetchSavedViews")).toEqual([
			{ name: "FetchSavedViews", args: { surface: "logs", revision: 0 } },
		])
	})

	test("saving stores the URL's params, and a relative window stays relative", () => {
		const saved = views.saveAs(entered(ERRORS_LAST_HOUR, []), "Checkout errors")
		expect(sentNamed(saved.commands, "CreateSavedView")).toEqual([
			{
				name: "CreateSavedView",
				args: {
					surface: "logs",
					name: "Checkout errors",
					state: { search: { severities: ["ERROR"], services: ["checkout"], timePreset: "1h" } },
					visibility: "private",
				},
			},
		])
	})

	test("an absolute window, the columns and the where clause are saved as the URL holds them", () => {
		const search: Search = {
			startTime: "2026-10-01 08:00:00",
			endTime: "2026-10-01 09:00:00",
			columns: ["http.route"],
			whereClause: 'service.name = "checkout"',
			attributeFilters: [{ key: "http.route", value: "/pay" }],
		}
		const saved = views.saveAs(entered(search, []), "Pay route")
		expect(sentNamed(saved.commands, "CreateSavedView")[0]?.args).toEqual({
			surface: "logs",
			name: "Pay route",
			state: { search },
			visibility: "private",
		})
	})

	test("the toolbar names the view this URL is, and picking another goes to its params", () => {
		const model = entered(ERRORS_LAST_HOUR, [ERRORS, WARNINGS])
		scene(
			{ update: pageUpdate, view },
			given(model),
			...pageMounts,
			expectView(role("button", { name: "Checkout errors" })).toExist(),
			expectView(text("Edited")).not.toExist(),
		)
		expect(navigationOf(views.open(model, WARNINGS).outMessage)).toEqual({
			url: '/logs?severities=["WARN"]&timePreset=24h',
			isReplace: false,
		})
	})

	test("a URL that matches no view leaves the button at Views", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered({ severities: ["WARN"] }, [ERRORS])),
			...pageMounts,
			expectView(role("button", { name: "Views" })).toExist(),
		)
	})

	test("a filter changed after opening a view reads Edited, and Update view stores the new params", () => {
		const opened = views.open(entered(ERRORS_LAST_HOUR, [ERRORS]), ERRORS).model
		const edited = routeChanged(
			opened,
			{ search: { ...ERRORS_LAST_HOUR, severities: ["ERROR", "FATAL"] } },
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(edited),
			...pageMounts,
			expectView(role("button", { name: /Checkout errors\s*Edited/ })).toExist(),
		)
		expect(sentNamed(views.update(edited).commands, "UpdateSavedViewState")).toEqual([
			{
				name: "UpdateSavedViewState",
				args: {
					viewId: ERRORS.id,
					state: {
						search: { severities: ["ERROR", "FATAL"], services: ["checkout"], timePreset: "1h" },
					},
				},
			},
		])
	})

	test("a page entered on a view's URL keeps that view once a filter changes, without picking it", () => {
		// A reload or a shared link: nothing was opened from the menu.
		const entry = entered(ERRORS_LAST_HOUR, [ERRORS, WARNINGS])
		const edited = routeChanged(
			entry,
			{ search: { ...ERRORS_LAST_HOUR, timePreset: "6h" } },
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(edited),
			...pageMounts,
			expectView(role("button", { name: /Checkout errors\s*Edited/ })).toExist(),
		)
		expect(sentNamed(views.update(edited).commands, "UpdateSavedViewState")[0]?.args).toEqual({
			viewId: ERRORS.id,
			state: { search: { severities: ["ERROR"], services: ["checkout"], timePreset: "6h" } },
		})
		// Editing on to another view's params makes that one the page's view.
		const onWarnings = routeChanged(
			edited,
			{ search: { severities: ["WARN"], timePreset: "24h" } },
			context,
		)
		scene(
			{ update: pageUpdate, view },
			given(onWarnings.model),
			...pageMounts,
			expectView(role("button", { name: "Warnings today" })).toExist(),
			expectView(text("Edited")).not.toExist(),
		)
	})

	test("a renamed view shows its new name in the toolbar", () => {
		scene(
			{ update: pageUpdate, view },
			given(views.renamed(entered(ERRORS_LAST_HOUR, [ERRORS]), ERRORS, "Checkout failures")),
			...pageMounts,
			dialogMounted,
			expectView(role("button", { name: "Checkout failures" })).toExist(),
		)
	})

	test("deleting the page's view returns the toolbar to Views", () => {
		const deleting = views.confirmDelete(entered(ERRORS_LAST_HOUR, [ERRORS]))
		expect(sentNamed(deleting.commands, "DeleteSavedView")).toEqual([
			{ name: "DeleteSavedView", args: { viewId: ERRORS.id } },
		])
		scene(
			{ update: pageUpdate, view },
			given(views.deleted(deleting.model, ERRORS)),
			...pageMounts,
			dialogMounted,
			expectView(role("button", { name: "Views" })).toExist(),
		)
	})

	test("an update the server refuses is said in a toast", () => {
		const opened = views.open(entered(ERRORS_LAST_HOUR, [ERRORS]), ERRORS).model
		const edited = routeChanged(opened, { search: { severities: ["WARN"] } }, context).model
		const failed = pageUpdate(
			views.update(edited).model,
			toViews(
				SavedViews.Message.CompletedUpdateView({
					action: "update",
					viewId: ERRORS.id,
					sharedBefore: null,
					result: Result.fail(toLoadFailure("Saved views could not be changed")),
				}),
			),
		)
		expect(failed.outMessage).toMatchObject({ _tag: "RequestedToast", title: "Couldn't update view" })
	})

	test("opening a view replaces the search box's draft and drops the draft's pending debounce", () => {
		const TIMEOUTS = savedView("logs", "0c", "Timeouts", {
			search: { search: "timeout", timePreset: "1h" },
		})
		const typed = pageUpdate(
			entered({ search: "refused" }, [TIMEOUTS]),
			Message.ChangedSearchText({ text: "refused again" }),
		).model
		const opened = views.open(typed, TIMEOUTS)
		expect(opened.model.searchText).toBe("timeout")
		expect(navigationOf(opened.outMessage)?.url).toContain("timeout")
		// The debounce the old draft started fires after the view opened: it must not navigate.
		expect(
			pageUpdate(opened.model, Message.ElapsedSearchDebounce({ generation: typed.searchGeneration }))
				.outMessage,
		).toBeUndefined()
	})
})
