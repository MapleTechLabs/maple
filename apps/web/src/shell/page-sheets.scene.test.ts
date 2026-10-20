import * as Animation from "@foldkit/ui/animation"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { Command, Mount, click, expect, given, role, scene, selector, withViewInputs } from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import { dashboardPage } from "../page/kit/dashboard-page"
import * as Dialog from "../ui/dialog"
import { Message } from "./message"
import { init, type Model } from "./model"
import { MeasureSidebarOverflow } from "./mounts"
import { routeChanged, update } from "./update"
import { frameView } from "./view"

// The page rails below `lg`: lifted out of the body into sheets the top bar opens.

const flags = { isMobile: true, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

const signedIn = (overrides: Partial<Model> = {}): Model => ({
	...init({ ...flags, isFilterCollapsed: true }),
	maybeOrgId: Option.some("org_parity"),
	hasRequestedSidebarData: true,
	...overrides,
})

/** The frame around a page with a filter rail and a context rail, as `dashboardPage` renders them. */
const view = (model: Model, h: HtmlBuilder<Message>) =>
	withViewInputs(frameView, {
		currentPath: "/services",
		breadcrumbs: [{ label: "Services" }],
		page: () =>
			dashboardPage(
				h,
				{ filters: h.p([], ["Health filter"]), rightPanel: h.p([], ["Deploy context"]) },
				[h.p([], ["Service rows"])],
			),
		topbarActions: () => null,
	})()(model, h)

const filtersDialog = role("dialog", { name: "Filters" })
const openFilters = role("button", { name: "Open filters" })

const openedFilters = () => [
	click(openFilters),
	Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

describe("page rails below lg", () => {
	test("the rails leave the body; the top bar gets a trigger for each", () => {
		scene(
			{ update, view },
			given(signedIn()),
			expect(selector('[data-slot="page-filter-sidebar"]')).toBeAbsent(),
			expect(selector('[data-slot="page-right-sidebar"]')).toBeAbsent(),
			expect(role("button", { name: "Open context" })).toExist(),
			expect(openFilters).toExist(),
			expect(filtersDialog).toBeAbsent(),
		)
	})

	test("Open filters shows the page's filter rail in a left sheet", () => {
		scene(
			{ update, view },
			given(signedIn()),
			...openedFilters(),
			expect(filtersDialog).toExist(),
			expect(filtersDialog).toContainText("Health filter"),
			expect(selector('[data-slot="sheet-popup"]')).toHaveAttr("data-open", ""),
		)
	})

	test("at lg and up the rails stay inline and no trigger is drawn", () => {
		scene(
			{ update, view },
			given(signedIn({ isMobile: false, isFilterCollapsed: false })),
			Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow()),
			expect(selector('[data-slot="page-filter-sidebar"]')).toContainText("Health filter"),
			expect(openFilters).toBeAbsent(),
		)
	})

	test("a search change keeps the sheet open; another page closes it", () => {
		const open = update(signedIn(), Message.ClickedOpenFilters()).model
		expectVitest(routeChanged(true)(open).model.filterSheet.isOpen).toBe(true)
		expectVitest(routeChanged(false)(open).model.filterSheet.isOpen).toBe(false)
	})
})
