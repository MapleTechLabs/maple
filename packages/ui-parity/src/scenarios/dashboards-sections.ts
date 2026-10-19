import type { Page } from "playwright"
import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { Scenario } from "./types.ts"

/**
 * The grouped board (`dash_parity_ops_sections`): a tabbed group, a group collapsed by default and
 * a pinned empty one. Every structural write is clicked through so its payload lands in the log.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const grouped = `/dashboards/${SEEDED.sectionsDashboard}`

const enterEdit = clickButton("Edit dashboard")
const clickTab = (name: string) => (page: Page) => page.getByRole("tab", { name }).first().click()
const clickMenuItem = (name: string | RegExp) => (page: Page) =>
	page.getByRole("menuitem", { name }).first().click()
const widgetActions = (index: number) => (page: Page) =>
	page.getByRole("button", { name: "Widget actions" }).nth(index).click()
const pickerTab = (name: string) => (page: Page) => page.getByRole("tab", { name }).click()
const openMenu = clickButton("Latency options")

const MENU_WRITES = [
	["add-tab", "Add tab"],
	["move-down", "Move down"],
	["collapsed-default", "Collapsed by default"],
	["always-expanded", "Always expanded"],
] as const

export const groupedScenarios: ReadonlyArray<Scenario> = [
	dashboard("sections", "Grouped board: a tabbed group, a collapsed one and a pinned one", grouped, {
		fullPage: true,
	}),
	dashboard("sections-tab", "Grouped board: the Breakdown tab", grouped, {
		steps: act(clickTab("Breakdown")),
		fullPage: true,
	}),
	dashboard("sections-expanded", "Grouped board: the collapsed Errors group expanded", grouped, {
		steps: act(clickButton("Expand Errors")),
		fullPage: true,
	}),
	dashboard("sections-collapsed", "Grouped board: the Latency group collapsed", grouped, {
		steps: act(clickButton("Collapse Latency")),
		fullPage: true,
	}),
	dashboard("sections-edit", "Grouped board in edit mode", grouped, { steps: act(enterEdit), fullPage: true }),
	dashboard("sections-menu", "Grouped board: a group's options menu", grouped, {
		steps: act(enterEdit, openMenu),
	}),
	...MENU_WRITES.map(([id, item]) =>
		dashboard(`sections-${id}`, `Grouped board: ${item} from a group's menu`, grouped, {
			steps: act(enterEdit, openMenu, clickMenuItem(item)),
			fullPage: true,
		}),
	),
	dashboard("sections-delete-dialog", "Grouped board: delete a group, confirmation", grouped, {
		steps: act(enterEdit, openMenu, clickMenuItem("Delete group…")),
	}),
	dashboard("sections-delete-keep", "Grouped board: a group deleted, its widgets kept", grouped, {
		steps: act(enterEdit, openMenu, clickMenuItem("Delete group…"), clickButton("Keep widgets")),
		fullPage: true,
	}),
	dashboard("sections-delete-all", "Grouped board: a group deleted with its widgets", grouped, {
		steps: act(enterEdit, openMenu, clickMenuItem("Delete group…"), clickButton("Delete group & widgets")),
	}),
	dashboard("sections-tab-delete", "Grouped board: a tab deleted, its widgets moved", grouped, {
		steps: act(enterEdit, clickButton("Delete tab Breakdown"), clickButton("Move to “Overview”")),
		fullPage: true,
	}),
	dashboard("sections-renamed", "Grouped board: a group renamed inline", grouped, {
		steps: act(enterEdit, async (page) => {
			await page.getByRole("button", { name: "Rename group Latency" }).dblclick()
			const input = page.getByRole("textbox", { name: "Rename group Latency" })
			await input.fill("Latency SLOs")
			await input.press("Enter")
		}),
	}),
	dashboard("sections-add-group", "Grouped board: Add group from the more actions menu", grouped, {
		steps: act(enterEdit, clickButton("More dashboard actions"), clickMenuItem("Add group")),
		fullPage: true,
	}),
	dashboard("sections-widget-added", "Grouped board: a stat added into a group", grouped, {
		steps: act(enterEdit, clickButton("Add widget to Latency"), pickerTab("Stats"), clickButton(/Sum of logs/)),
		fullPage: true,
	}),
	dashboard("sections-widget-move-menu", "Grouped board: a tile's Move to submenu", grouped, {
		steps: act(enterEdit, widgetActions(1), async (page) => {
			// From the keyboard: a hover-opened submenu waits on a timer the frozen clock never fires.
			for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight"]) {
				await page.keyboard.press(key)
				await page.waitForTimeout(100)
			}
		}),
	}),
	dashboard("sections-widget-moved", "Grouped board: a tile moved out of its group", grouped, {
		steps: act(enterEdit, widgetActions(1), clickMenuItem("Move to"), clickMenuItem("Ungrouped")),
		fullPage: true,
	}),
]
