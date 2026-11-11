import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import {
	all,
	Command,
	click,
	expect,
	expectAll,
	given,
	Mount,
	role,
	scene,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import { SaveCollapsedNavGroups } from "./command"
import { Message } from "./message"
import { init, type Model } from "./model"
import { MeasureSidebarOverflow } from "./mounts"
import { update } from "./update"
import { frameView } from "./view"

// The sidebar's group labels fold their rows, remembered across reloads.

const flags = { isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

const signedIn = (overrides: Partial<Model> = {}): Model => ({
	...init(flags),
	maybeOrgId: Option.some("org_parity"),
	hasRequestedSidebarData: true,
	...overrides,
})

const shellAt = (currentPath: string) => {
	const frame = withViewInputs(frameView, {
		currentPath,
		breadcrumbs: [{ label: "Overview" }],
		page: () => null,
		topbarActions: () => null,
	})()
	return (model: Model, h: HtmlBuilder<Message>) => frame(model, h)
}

const analyze = role("button", { name: "Analyze" })
const dashboards = role("link", { name: "Dashboards" })
const measured = Mount.resolve(MeasureSidebarOverflow, Message.MeasuredSidebarOverflow())

describe("sidebar groups", () => {
	test("a group label folds its rows, saves the folded set, and unfolds again", () => {
		scene(
			{ update, view: shellAt("/") },
			given(signedIn()),
			measured,
			expect(analyze).toHaveAttr("aria-expanded", "true"),
			expect(dashboards).toExist(),
			click(analyze),
			Command.expectExact(SaveCollapsedNavGroups({ groups: ["analyze"] })),
			Command.resolve(SaveCollapsedNavGroups, Message.CompletedSaveNavGroups()),
			expect(analyze).toHaveAttr("aria-expanded", "false"),
			expect(dashboards).toBeAbsent(),
			expect(role("link", { name: "Errors" })).toExist(),
			click(analyze),
			Command.expectExact(SaveCollapsedNavGroups({ groups: [] })),
			Command.resolve(SaveCollapsedNavGroups, Message.CompletedSaveNavGroups()),
			expect(dashboards).toExist(),
		)
	})

	test("a folded group read from storage starts folded", () => {
		scene(
			{ update, view: shellAt("/") },
			given(signedIn({ collapsedNavGroups: ["triage"] })),
			measured,
			expect(role("button", { name: "Triage" })).toHaveAttr("aria-expanded", "false"),
			expect(role("link", { name: "Alerts" })).toBeAbsent(),
		)
	})

	test("folding the group holding the current page keeps only the current page's row", () => {
		const triage = role("button", { name: "Triage" })
		scene(
			{ update, view: shellAt("/alerts") },
			given(signedIn()),
			measured,
			expect(role("link", { name: "Errors" })).toExist(),
			click(triage),
			Command.resolve(SaveCollapsedNavGroups, Message.CompletedSaveNavGroups()),
			expect(triage).toHaveAttr("aria-expanded", "false"),
			expect(role("link", { name: "Alerts" })).toExist(),
			expect(role("link", { name: "Errors" })).toBeAbsent(),
			expect(role("link", { name: "Code review & CI" })).toBeAbsent(),
		)
	})

	test("a folded group on a sub-item's page keeps the section row and that sub-item alone", () => {
		const explore = role("link", { name: "Explore" })
		const logs = role("link", { name: "Logs" })
		scene(
			{ update, view: shellAt("/logs") },
			given(signedIn()),
			measured,
			// Open: the tint is the sub-item's, the parent only keeps its weight.
			expect(logs).toHaveAttr("data-active", "true"),
			expect(explore).toHaveAttr("data-active", "child"),
			click(analyze),
			Command.resolve(SaveCollapsedNavGroups, Message.CompletedSaveNavGroups()),
			// Still Logs: the section row alone would link to Traces and name no current page.
			expect(logs).toHaveAttr("data-active", "true"),
			expect(explore).toHaveAttr("data-active", "child"),
			expect(role("link", { name: "Traces" })).toBeAbsent(),
			expect(dashboards).toBeAbsent(),
		)
	})

	test("one link is the current page: the sub-item, with its group open or folded", () => {
		const explore = role("link", { name: "Explore" })
		const current = all.role("link", { current: "page" })
		scene(
			// Explore links to `/traces`, the page its Traces sub-item is.
			{ update, view: shellAt("/traces") },
			given(signedIn()),
			measured,
			expectAll(current).toHaveCount(1),
			expect(role("link", { name: "Traces" })).toHaveAttr("aria-current", "page"),
			expect(explore).toHaveAttr("data-active", "child"),
			click(analyze),
			Command.resolve(SaveCollapsedNavGroups, Message.CompletedSaveNavGroups()),
			expectAll(current).toHaveCount(1),
			expect(role("link", { name: "Traces" })).toHaveAttr("aria-current", "page"),
			expect(explore).toHaveAttr("data-active", "child"),
		)
	})

	test("the collapsed rail shows every row of a folded group and its labels are no tab stops", () => {
		scene(
			{ update, view: shellAt("/") },
			given(signedIn({ isSidebarOpen: false, collapsedNavGroups: ["analyze"] })),
			measured,
			expect(dashboards).toExist(),
			expect(analyze).toBeAbsent(),
		)
	})

	test("folding persists only the groups the user folded", () => {
		const folded = update(
			update(signedIn(), Message.ClickedNavGroup({ groupId: "monitor" })).model,
			Message.ClickedNavGroup({ groupId: "triage" }),
		)
		expectVitest(folded.model.collapsedNavGroups).toEqual(["monitor", "triage"])
	})
})
