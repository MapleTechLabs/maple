import { OrgId } from "@maple/domain"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import * as Dialog from "@maple/views/ui/dialog"
import { Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import * as SavedViews from "../kit/saved-views"
import { navigationOf, savedView, sentNamed, viewsDriver } from "../kit/saved-views/test-views"
import { Message as BrowseMessage } from "./browse/message"
import type { Model as BrowseModel } from "./browse/model"
import * as Browse from "./browse/update"
import { view as browsePageView } from "./browse/view"
import { Message as DetailMessage } from "./detail/message"
import type { Model as DetailModel } from "./detail/model"
import * as Detail from "./detail/update"
import { view as detailPageView } from "./detail/view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const DURATION = "http.server.request.duration"

const browseUpdate = (model: BrowseModel, message: BrowseMessage) => Browse.update(model, message, context)
const browseView = withViewInputs(browsePageView, { context })()
const browseViews = viewsDriver((model: BrowseModel, message) =>
	browseUpdate(model, BrowseMessage.GotSavedViewsMessage({ message })),
)

const detailUpdate = (model: DetailModel, message: DetailMessage) => Detail.update(model, message, context)
const detailView = withViewInputs(detailPageView, { context })()
const detailViews = viewsDriver((model: DetailModel, message) =>
	detailUpdate(model, DetailMessage.GotSavedViewsMessage({ message })),
)

type BrowseSearch = BrowseModel["search"]

const HISTOGRAMS = savedView("metrics", "0a", "Histograms", {
	search: { type: "histogram", view: "table", timePreset: "24h" },
})
/** Saved on the metric's own page: it carries the metric. */
const P99_BY_ROUTE = savedView("metrics", "0b", "Latency by route", {
	search: { agg: "max", groupBy: "http.route", timePreset: "6h" },
	metricName: DURATION,
})

const browsing = (search: BrowseSearch, listed: ReadonlyArray<SavedViews.SavedView>): BrowseModel =>
	browseViews.listed(
		browseUpdate(
			Browse.init({ search }, context).model,
			BrowseMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model,
		listed,
	)

const onMetric = (
	metricName: string,
	search: Detail.Search,
	listed: ReadonlyArray<SavedViews.SavedView>,
): DetailModel =>
	detailViews.listed(
		detailUpdate(
			Detail.init({ metricName, search }, context).model,
			DetailMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model,
		listed,
	)

const themeResolved = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
/** A dialog on screen, open or still leaving. */
const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

describe("metrics saved views", () => {
	test("both metrics pages read the same list on entry", () => {
		const expected = [{ name: "FetchSavedViews", args: { surface: "metrics", revision: 0 } }]
		expect(sentNamed(Browse.init({ search: {} }, context).commands, "FetchSavedViews")).toEqual(expected)
		expect(
			sentNamed(Detail.init({ metricName: DURATION, search: {} }, context).commands, "FetchSavedViews"),
		).toEqual(expected)
	})

	test("saving on /metrics stores the search, the type, the layout and the window", () => {
		const saved = browseViews.saveAs(
			browsing({ q: "http", type: "histogram", view: "table", timePreset: "24h" }, []),
			"Http histograms",
		)
		expect(sentNamed(saved.commands, "CreateSavedView")).toEqual([
			{
				name: "CreateSavedView",
				args: {
					surface: "metrics",
					name: "Http histograms",
					state: { search: { q: "http", type: "histogram", view: "table", timePreset: "24h" } },
					visibility: "private",
				},
			},
		])
	})

	test("saving on a metric's page stores the metric with its query", () => {
		const saved = detailViews.saveAs(
			onMetric(DURATION, { agg: "max", groupBy: "http.route", timePreset: "6h" }, []),
			"Latency by route",
		)
		expect(sentNamed(saved.commands, "CreateSavedView")[0]?.args).toEqual({
			surface: "metrics",
			name: "Latency by route",
			state: {
				search: { agg: "max", groupBy: "http.route", timePreset: "6h" },
				metricName: DURATION,
			},
			visibility: "private",
		})
	})

	test("/metrics names the view its URL is, and a metric's view opens that metric's page", () => {
		const model = browsing({ type: "histogram", view: "table", timePreset: "24h" }, [
			HISTOGRAMS,
			P99_BY_ROUTE,
		])
		scene(
			{ update: browseUpdate, view: browseView },
			given(model),
			themeResolved,
			expectView(role("button", { name: "Histograms" })).toExist(),
		)
		expect(navigationOf(browseViews.open(model, P99_BY_ROUTE).outMessage)).toEqual({
			url: `/metrics/${DURATION}?agg=max&groupBy=http.route&timePreset=6h`,
			isReplace: false,
		})
	})

	test("a metric's page names its view, and the same query on another metric is not that view", () => {
		const query: Detail.Search = { agg: "max", groupBy: "http.route", timePreset: "6h" }
		scene(
			{ update: detailUpdate, view: detailView },
			given(onMetric(DURATION, query, [HISTOGRAMS, P99_BY_ROUTE])),
			themeResolved,
			expectView(role("button", { name: "Latency by route" })).toExist(),
		)
		scene(
			{ update: detailUpdate, view: detailView },
			given(onMetric("http.client.request.duration", query, [HISTOGRAMS, P99_BY_ROUTE])),
			themeResolved,
			expectView(role("button", { name: "Views" })).toExist(),
		)
		// From a metric's page a browse view goes back to /metrics.
		expect(
			navigationOf(
				detailViews.open(onMetric(DURATION, query, [HISTOGRAMS, P99_BY_ROUTE]), HISTOGRAMS)
					.outMessage,
			),
		).toEqual({ url: "/metrics?type=histogram&view=table&timePreset=24h", isReplace: false })
	})

	test("a query changed after opening a view reads Edited, and Update view keeps the metric", () => {
		const opened = detailViews.open(
			onMetric(DURATION, { agg: "max", groupBy: "http.route", timePreset: "6h" }, [P99_BY_ROUTE]),
			P99_BY_ROUTE,
		).model
		const edited = Detail.routeChanged(
			opened,
			{ metricName: DURATION, search: { agg: "avg", groupBy: "http.route", timePreset: "6h" } },
			context,
		).model
		scene(
			{ update: detailUpdate, view: detailView },
			given(edited),
			themeResolved,
			expectView(role("button", { name: /Latency by route\s*Edited/ })).toExist(),
		)
		expect(sentNamed(detailViews.update(edited).commands, "UpdateSavedViewState")).toEqual([
			{
				name: "UpdateSavedViewState",
				args: {
					viewId: P99_BY_ROUTE.id,
					state: {
						search: { agg: "avg", groupBy: "http.route", timePreset: "6h" },
						metricName: DURATION,
					},
				},
			},
		])
	})

	test("a metric view opened from /metrics stays the metric page's view once its query changes", () => {
		// The metric's page is a new instance: it only has the URL and the list to go by.
		const arrived = onMetric(DURATION, { agg: "max", groupBy: "http.route", timePreset: "6h" }, [
			HISTOGRAMS,
			P99_BY_ROUTE,
		])
		const edited = Detail.routeChanged(
			arrived,
			{ metricName: DURATION, search: { agg: "avg", groupBy: "http.route", timePreset: "6h" } },
			context,
		).model
		scene(
			{ update: detailUpdate, view: detailView },
			given(edited),
			themeResolved,
			expectView(role("button", { name: /Latency by route\s*Edited/ })).toExist(),
		)
		expect(sentNamed(detailViews.update(edited).commands, "UpdateSavedViewState")[0]?.args).toEqual({
			viewId: P99_BY_ROUTE.id,
			state: { search: { agg: "avg", groupBy: "http.route", timePreset: "6h" }, metricName: DURATION },
		})
	})

	test("a renamed view shows its new name on /metrics", () => {
		const model = browsing({ type: "histogram", view: "table", timePreset: "24h" }, [HISTOGRAMS])
		scene(
			{ update: browseUpdate, view: browseView },
			given(browseViews.renamed(model, HISTOGRAMS, "All histograms")),
			themeResolved,
			dialogMounted,
			expectView(role("button", { name: "All histograms" })).toExist(),
			expectView(text("Edited")).not.toExist(),
		)
	})

	test("deleting the page's view returns the toolbar to Views", () => {
		const deleting = detailViews.confirmDelete(
			onMetric(DURATION, { agg: "max", groupBy: "http.route", timePreset: "6h" }, [P99_BY_ROUTE]),
		)
		expect(sentNamed(deleting.commands, "DeleteSavedView")).toEqual([
			{ name: "DeleteSavedView", args: { viewId: P99_BY_ROUTE.id } },
		])
		scene(
			{ update: detailUpdate, view: detailView },
			given(detailViews.deleted(deleting.model, P99_BY_ROUTE)),
			themeResolved,
			dialogMounted,
			expectView(role("button", { name: "Views" })).toExist(),
		)
	})

	test("opening a view drops the search box's unsent draft, even when the view's query is the current one", () => {
		const HTTP_HISTOGRAMS = savedView("metrics", "0c", "HTTP histograms", {
			search: { q: "http", type: "histogram" },
		})
		const typed = browseUpdate(
			browsing({ q: "http" }, [HTTP_HISTOGRAMS]),
			BrowseMessage.ChangedSearchInput({ value: "grpc" }),
		).model
		const opened = browseViews.open(typed, HTTP_HISTOGRAMS)
		expect(opened.model.searchInput).toBe("http")
		// The debounce "grpc" started fires after the view opened: it must not replace the view's query.
		expect(
			browseUpdate(
				opened.model,
				BrowseMessage.CompletedSearchDebounce({ generation: typed.searchGeneration }),
			).outMessage,
		).toBeUndefined()
	})

	test("on a metric's page, opening a view replaces the where draft and drops its pending debounce", () => {
		const query = { agg: "max", groupBy: "http.route", timePreset: "6h" } as const
		const typed = detailUpdate(
			onMetric(DURATION, query, [P99_BY_ROUTE]),
			DetailMessage.ChangedWhereInput({ value: 'http.route = "/cart"' }),
		).model
		const opened = detailViews.open(typed, P99_BY_ROUTE)
		expect(opened.model.whereInput).toBe("")
		// The debounce the draft started fires after the view opened: it must not navigate.
		expect(
			detailUpdate(
				opened.model,
				DetailMessage.CompletedWhereDebounce({ generation: typed.whereGeneration }),
			).outMessage,
		).toBeUndefined()
	})
})
