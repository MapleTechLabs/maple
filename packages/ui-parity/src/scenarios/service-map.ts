import type { Page } from "playwright"
import { act, clickButton, EMPTY, OPS, opsScenarios } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Service map on `acme-ops`: selection and the service and database panels, the toolbar (focus,
 * depth, hide rest, traffic, colour, Re-sort and its tooltip), namespace collapse, the legend
 * popover, node drag, the header controls, and the loading and error states. Expanding a collapsed
 * namespace is scene-tested only: legacy's camera after it differs from run to run.
 */
const map = opsScenarios("service-map", "Service map")

const canvas = (page: Page) => page.getByRole("application")

const selectNode = (name: string) => (page: Page) =>
	canvas(page).getByText(name, { exact: true }).first().click()

const pickOption = (combobox: string, option: string) => async (page: Page) => {
	await page.getByRole("combobox", { name: combobox }).click()
	await page.getByRole("option", { name: option }).click()
}

/** The header's 2D / 3D switch. */
const pickView = (name: "2D" | "3D") => (page: Page) =>
	page.getByRole("group", { name: "Service map view" }).getByRole("button", { name }).click()

const focusService = (name: string) => async (page: Page) => {
	await page.getByRole("combobox", { name: "Focus a service…" }).click()
	await page.getByRole("option", { name }).click()
}

/** A node card dragged by `(dx, dy)` with the mouse, as React Flow's XYDrag sees it. */
const dragNode = (name: string, dx: number, dy: number) => async (page: Page) => {
	const box = await canvas(page).getByText(name, { exact: true }).first().boundingBox()
	if (box === null) throw new Error(`no box for ${name}`)
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
	await page.mouse.move(x + dx, y + dy, { steps: 4 })
	await page.mouse.up()
}

/**
 * Legacy's automatic refit after a relayout races ELK, its deferred namespace boxes and React
 * Flow's store (the camera differs run to run), so these scenarios frame the result themselves.
 */
/** Lets a relayout land (and the 400 ms camera write run) before the next step. */
const settle = (page: Page) => page.waitForTimeout(800)

/** A full reload: the map comes back from what it stored in localStorage. */
const reloadPage = async (page: Page) => {
	await page.reload()
	await page.getByRole("application").waitFor()
}

const fitView = async (page: Page) => {
	await page.waitForTimeout(800)
	await page.getByRole("button", { name: "Fit view" }).click()
}

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const timed = (
	id: string,
	title: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
	path = "/service-map",
): Scenario => ({
	id: `service-map-${id}`,
	title: `Service map: ${title}`,
	path,
	dataset: OPS,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	faults,
	settle,
	area: "service-map",
})

const failing = (tag: string) => ({
	failures: {
		[tag]: {
			status: 502,
			body: {
				_tag: "@maple/http/errors/QueryEngineExecutionError",
				message: "ui-parity: injected service map failure",
			},
		},
	},
})

export const serviceMapArea: AreaModule = {
	area: "service-map",
	scenarios: [
		map("selected", "payment-svc selected", "/service-map", { steps: act(selectNode("payment-svc")) }),
		map("collapsed", "shop namespace collapsed", "/service-map", {
			steps: act(clickButton("Collapse shop into one node")),
		}),
		map("color-health", "Nodes colored by health", "/service-map", {
			steps: act(pickOption("Color nodes by", "Health")),
		}),
		map("empty", "Service map (empty org)", "/service-map", { dataset: EMPTY }),
		map("3d", "the 3D view", "/service-map?view=3d"),
		map("3d-toggle", "switched from 2D to 3D", "/service-map", { steps: act(pickView("3D")) }),
		map("3d-toggle-back", "switched from 3D back to 2D", "/service-map?view=3d", {
			steps: act(pickView("2D")),
		}),
		map("3d-cascade", "the 3D Cascade perspective", "/service-map?view=3d", {
			steps: act((page) => page.getByRole("button", { name: "Cascade" }).click()),
		}),
		map("3d-hover", "a 3D sign hovered", "/service-map?view=3d", {
			steps: (page) => page.getByRole("button", { name: "Select payment-svc" }).hover(),
		}),
		map("3d-selected", "payment-svc selected from its 3D sign", "/service-map?view=3d", {
			steps: act(clickButton("Select payment-svc")),
		}),
		map("3d-belt", "a belt tag picked, its target selected", "/service-map?view=3d", {
			steps: act(clickButton(/^Inspect connection to /)),
		}),
		map("3d-deselected", "a 3D selection cleared from its sign", "/service-map?view=3d", {
			steps: act(clickButton("Select payment-svc"), clickButton("Select payment-svc")),
		}),
		map("3d-zoom-in", "the 3D camera zoomed in", "/service-map?view=3d", {
			steps: act(clickButton("Zoom in")),
		}),
		map("3d-zoom-reset", "the 3D camera zoomed out, then reset", "/service-map?view=3d", {
			steps: act(clickButton("Zoom out"), clickButton("Reset camera")),
		}),
		map("color-platform", "Nodes colored by platform", "/service-map", {
			steps: act(pickOption("Color nodes by", "Platform")),
		}),
		map("traffic", "traffic above 5% of peak, edges hidden", "/service-map", {
			steps: act(pickOption("Traffic threshold", "> 5% of peak"), fitView),
		}),
		map("traffic-show-all", "the hidden-edges button resets the threshold", "/service-map", {
			steps: act(
				pickOption("Traffic threshold", "> 5% of peak"),
				fitView,
				clickButton(/edges hidden$/),
				fitView,
			),
		}),
		map("focus", "payment-svc focused from the combobox", "/service-map", {
			steps: act(focusService("payment-svc")),
		}),
		map("focus-search", "the focus combobox filtered by typing", "/service-map", {
			steps: async (page) => {
				await page.getByRole("combobox", { name: "Focus a service…" }).fill("pay")
				await page.getByRole("option", { name: "payment-svc" }).waitFor()
			},
		}),
		// Framed first: legacy's d3 camera starts a fraction off the drawn one (its cancelled first fit).
		map("zoom-in", "framed, then zoomed in twice from the controls", "/service-map", {
			steps: act(fitView, clickButton("Zoom in"), clickButton("Zoom in")),
		}),
		map("focus-hide", "focused, rest hidden", "/service-map", {
			steps: act(focusService("payment-svc"), clickButton("Hide rest"), fitView),
		}),
		map("focus-depth", "focused two hops deep", "/service-map", {
			steps: act(focusService("cart-svc"), pickOption("Focus depth", "2 hops")),
		}),
		map("focus-clear", "focus cleared again", "/service-map", {
			steps: act(focusService("payment-svc"), clickButton("Clear focus")),
		}),
		map("focus-from-panel", "focused from the service panel", "/service-map", {
			steps: act(
				selectNode("payment-svc"),
				clickButton("Focus the map on this service's neighborhood"),
			),
		}),
		map("focus-url", "focus read from the URL", "/service-map?focusService=checkout-api&focusHops=2"),
		map("panel-infrastructure", "the service panel's Infrastructure tab", "/service-map", {
			steps: act(selectNode("payment-svc"), (page) =>
				page.getByRole("tab", { name: /Infrastructure/ }).click(),
			),
		}),
		map("database-selected", "the shop database selected", "/service-map", {
			steps: act(selectNode("PostgreSQL")),
		}),
		map("cache-selected", "the cache selected", "/service-map", { steps: act(selectNode("Redis")) }),
		map("panel-close", "a selection closed from its panel", "/service-map", {
			steps: act(selectNode("payment-svc"), clickButton("Close")),
		}),
		map("legend-more", "the legend's +3 more popover", "/service-map", {
			steps: act(clickButton("+3 more")),
		}),
		map("drag", "storefront dragged", "/service-map", { steps: act(dragNode("storefront", 40, 260)) }),
		map("resort", "a drag undone by Re-sort", "/service-map", {
			steps: act(dragNode("storefront", 40, 260), clickButton("Re-sort")),
		}),
		map("resort-tooltip", "Re-sort hovered, its tooltip open", "/service-map", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Re-sort" }).hover()
				await page.getByText("Discard manual positions and auto-arrange").waitFor()
			},
		}),
		map("environment-all", "All environments picked", "/service-map", {
			steps: act(async (page) => {
				await page.getByRole("combobox").first().click()
				await page.getByRole("option", { name: "All environments" }).click()
			}),
		}),
		map("drag-persisted", "a drag kept across a page reload", "/service-map", {
			steps: act(dragNode("storefront", 40, 260), settle, reloadPage),
		}),
		map("collapsed-persisted", "a collapsed namespace kept across a page reload", "/service-map", {
			steps: act(clickButton("Collapse shop into one node"), settle, reloadPage),
		}),
		map("reload", "Reload clicked", "/service-map", { steps: act(clickButton("Reload")) }),
		map("time-range", "last 1 hour from the time range picker", "/service-map", {
			steps: act(async (page) => {
				await page.getByRole("button", { name: "Last 12 hours" }).click()
				await page.getByRole("dialog").getByRole("button", { name: "Last 1 hour" }).click()
				await page.getByRole("dialog").waitFor({ state: "detached" })
			}, fitView),
		}),
		map("integrations", "integrations connected, no traces (all environments)", "/service-map", {
			dataset: "infra-integrations",
		}),
		timed(
			"loading",
			"loading (bundle held)",
			{ delays: { "queryEngine.serviceMapBundle": HELD_MS } },
			"held",
		),
		timed("error", "the bundle failing", failing("queryEngine.serviceMapBundle"), "quiet"),
		timed("facets-error", "the environment facets failing", failing("queryEngine.executeBatch"), "quiet"),
		timed(
			"3d-loading",
			"3D, loading (bundle held)",
			{ delays: { "queryEngine.serviceMapBundle": HELD_MS } },
			"held",
			"/service-map?view=3d",
		),
		timed(
			"3d-error",
			"3D, the bundle failing",
			failing("queryEngine.serviceMapBundle"),
			"quiet",
			"/service-map?view=3d",
		),
	],
}
