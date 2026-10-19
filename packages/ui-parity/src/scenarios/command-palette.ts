import type { Page } from "playwright"
import type { AreaModule, Scenario, ViewportName } from "./types.ts"

/**
 * The command palette (`components/command-palette/`) over `/dashboards` on dataset `default`:
 * its two ways in, fuse search, keyboard navigation, every group's action and the shortcuts dialog.
 */
const palette = (
	id: string,
	title: string,
	steps: (page: Page) => Promise<void>,
	viewports: ReadonlyArray<ViewportName> = ["desktop", "mobile"],
): Scenario => ({
	id: `palette-${id}`,
	title: `Command palette: ${title}`,
	path: "/dashboards",
	dataset: "default",
	viewports,
	themes: ["light", "dark"],
	fullPage: false,
	steps,
	area: "palette",
})

const openByShortcut = async (page: Page) => {
	await page.keyboard.press("ControlOrMeta+KeyK")
	await page.getByRole("combobox").waitFor()
}

/** The sidebar's Search row; below `md` it sits in the nav sheet behind the top bar's trigger. */
const openByClick = async (page: Page) => {
	const search = page.getByRole("button", { name: /^Search/ })
	if (!(await search.isVisible()))
		await page.getByRole("button", { name: "Toggle sidebar" }).first().click()
	await search.click()
	await page.getByRole("combobox").waitFor()
}

const search = (query: string) => async (page: Page) => {
	await openByShortcut(page)
	await page.getByRole("combobox").fill(query)
}

const pick = (query: string, option: string | RegExp) => async (page: Page) => {
	await search(query)(page)
	await page.getByRole("option", { name: option, exact: typeof option === "string" }).click()
}

export const commandPaletteArea: AreaModule = {
	area: "palette",
	scenarios: [
		palette("open-shortcut", "opened with Mod+K", openByShortcut),
		palette("open-click", "opened from the sidebar's Search row", openByClick),
		palette("toggle-shortcut", "Mod+K again closes it", async (page) => {
			await openByShortcut(page)
			await page.keyboard.press("ControlOrMeta+KeyK")
		}),
		palette("escape", "Escape closes it", async (page) => {
			await openByShortcut(page)
			await page.keyboard.press("Escape")
		}),
		palette("search", "searching", search("pay")),
		palette("empty", "no results", search("zzqxv")),
		palette("arrows", "arrow keys move the highlight", async (page) => {
			await openByShortcut(page)
			await page.keyboard.press("ArrowDown")
			await page.keyboard.press("ArrowDown")
			await page.keyboard.press("ArrowDown")
			await page.keyboard.press("ArrowUp")
		}),
		palette("enter", "Enter opens the highlighted entry", async (page) => {
			await search("logs")(page)
			await page.keyboard.press("Enter")
		}),
		palette("arrows-enter", "arrows then Enter", async (page) => {
			await openByShortcut(page)
			await page.keyboard.press("ArrowDown")
			await page.keyboard.press("Enter")
		}),
		palette("navigation", "a page", pick("alerts", "Alerts")),
		palette("services", "services", search("store")),
		palette("service", "a service", pick("store", "storefront")),
		palette("dashboards", "dashboards", search("dashboard")),
		palette("dashboard", "a dashboard", pick("checkout health", "Checkout health")),
		palette("integrations", "integrations", search("connect")),
		palette("integration", "an integration", pick("railway", "Connect Railway")),
		palette(
			"chat-connector",
			"a chat connector, offered to every org",
			pick("discord", "Connect Discord"),
		),
		palette("theme", "the theme action", pick("mode", /Switch to (light|dark) mode/)),
		palette("ask-ai", "Ask Maple AI", pick("ask maple", /^Ask Maple AI/)),
		palette("shortcuts-action", "the shortcuts action", pick("keyboard", /^Keyboard shortcuts/)),
		palette("shortcuts-key", "? opens the shortcuts dialog", (page) =>
			page.keyboard.press("Shift+Slash"),
		),
		palette("theme-key", "T toggles the theme", (page) => page.keyboard.press("t"), ["desktop"]),
		// `/` focuses the page's tagged search (the logs search field).
		{
			...palette(
				"focus-search-key",
				"/ focuses the page search",
				(page) => page.keyboard.press("Slash"),
				["desktop"],
			),
			path: "/logs",
		},
		{
			...palette("services-loading", "services read held", openByShortcut),
			// "held" settles before the steps too, and the page itself sends no execute-batch.
			faults: { delays: { "queryEngine.executeBatch": 60_000 } },
		},
		{
			...palette("services-error", "services read failing", openByShortcut),
			faults: {
				failures: {
					"queryEngine.executeBatch": {
						status: 502,
						body: {
							_tag: "@maple/http/errors/QueryEngineExecutionError",
							message: "ui-parity: injected execute-batch failure",
						},
					},
				},
			},
		},
	],
}
