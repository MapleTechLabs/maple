import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * apps/local-ui interactions on dataset `local`: filters, search, range, paging, tabs, row
 * navigation, the connect popover and the sidebar. Each write lands in the call log as SQL.
 */

/** Past the 300 ms search debounce, so the query it commits is in flight before settling. */
const DEBOUNCE_MS = 500

const interaction = (id: string, title: string, hash: string, steps: (page: Page) => Promise<void>): Scenario => ({
	id: `local-${id}`,
	title: `Local ${title}`,
	path: `/#${hash}`,
	dataset: "local",
	app: "local",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "local-interactions",
	steps,
})

const typeInto = async (page: Page, placeholder: string, text: string) => {
	await page.getByPlaceholder(placeholder).fill(text)
	await page.waitForTimeout(DEBOUNCE_MS)
}

/** Rests on the `order.payload` chip until its card is up. */
const openJsonChip = async (page: Page) => {
	await page.getByRole("button", { name: /^Copy order\.payload=/ }).first().hover()
	await page.getByText("Attribute", { exact: true }).waitFor()
}

/** Lets the drag's layout write (and the 400 ms camera write) land before the next step. */
const MAP_SETTLE_MS = 800

/** A node card dragged by `(dx, dy)` with the mouse, as React Flow's XYDrag sees it. */
const dragNode = async (page: Page, name: string, dx: number, dy: number) => {
	const box = await page.getByRole("application").getByText(name, { exact: true }).first().boundingBox()
	if (box === null) throw new Error(`no box for ${name}`)
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
	await page.mouse.move(x + dx, y + dy, { steps: 4 })
	await page.mouse.up()
}

export const localInteractionsArea: AreaModule = {
	area: "local-interactions",
	scenarios: [
		// The label: Base UI's checkbox span sits under its hidden input.
		interaction("traces-has-error", "Traces: Has error", "/traces", (page) =>
			page.getByText("Has error", { exact: true }).click(),
		),
		interaction("traces-search", "Traces: search", "/traces", (page) => typeInto(page, "Filter by span name…", "checkout")),
		interaction("traces-range", "Traces: 24 h range", "/traces", async (page) => {
			await page.getByRole("combobox", { name: "Time range" }).selectOption("24h")
		}),
		interaction("traces-load-more", "Traces: load more", "/traces", (page) =>
			page.getByRole("button", { name: "Load more" }).click(),
		),
		// The loaded pages are saved with the list, so a reload opens on all of them.
		interaction("traces-load-more-reload", "Traces: load more, then reload", "/traces", async (page) => {
			await page.getByRole("button", { name: "Load more" }).click()
			await page.waitForTimeout(MAP_SETTLE_MS)
			await page.reload()
			await page.getByRole("link", { name: /^Trace / }).first().waitFor()
		}),
		interaction("traces-service-facet", "Traces: service facet", "/traces", (page) =>
			page.getByRole("checkbox", { name: "storefront" }).click(),
		),
		interaction("traces-open-trace", "Traces: open a trace", "/traces", (page) =>
			page.getByRole("link", { name: "Trace POST /api/checkout" }).first().click(),
		),
		interaction("services-env-facet", "Services: environment facet", "/services", (page) =>
			page.getByRole("checkbox", { name: "production" }).click(),
		),
		interaction("services-open", "Services: open a service", "/services", (page) =>
			page.getByRole("link", { name: /^checkout-api/ }).first().click(),
		),
		interaction("logs-patterns", "Logs: patterns", "/logs", (page) => page.getByRole("button", { name: "Patterns" }).click()),
		interaction("logs-severity", "Logs: severity facet", "/logs", (page) =>
			page.getByRole("checkbox", { name: "ERROR" }).click(),
		),
		interaction("logs-search", "Logs: search", "/logs", (page) => typeInto(page, "Search log bodies…", "pool")),
		interaction("logs-open-row", "Logs: open a log", "/logs", (page) =>
			page.getByRole("listitem", { name: /^WARN payment-svc: pool exhausted/ }).first().click(),
		),
		interaction("logs-open-error-row", "Logs: open an error log", "/logs?severity=ERROR", (page) =>
			page.getByRole("listitem", { name: /^ERROR payment-svc: ConnectionTimeout/ }).first().click(),
		),
		// Past the chip's 300 ms rest-to-reveal delay.
		interaction("logs-chip-card", "Logs: a chip's hover card", "/logs", async (page) => {
			await page.getByRole("button", { name: "Copy db.client.connection.pool.name=payments" }).first().hover()
			await page.waitForTimeout(DEBOUNCE_MS)
		}),
		// A JSON attribute's card: the collapsed preview, expanded, and its copy button's tooltip.
		{ ...interaction("logs-chip-json", "Logs: a JSON chip's card", "/logs", openJsonChip), dataset: "local-json" },
		{
			...interaction("logs-chip-json-expanded", "Logs: a JSON chip expanded", "/logs", async (page) => {
				await openJsonChip(page)
				await page.getByRole("button", { name: /^\{"orderId"/ }).click()
			}),
			dataset: "local-json",
		},
		{
			...interaction("logs-chip-json-copy-tooltip", "Logs: the JSON copy button's tooltip", "/logs", async (page) => {
				await openJsonChip(page)
				await page.getByRole("button", { name: /^\{"orderId"/ }).click()
				await page.getByRole("button", { name: "Copy JSON" }).hover()
				await page.getByText("Copy JSON", { exact: true }).waitFor()
			}),
			dataset: "local-json",
		},
		interaction("errors-expand", "Errors: expand a card", "/errors", (page) =>
			page.getByRole("button", { name: /^ConnectionTimeout/ }).click(),
		),
		interaction("errors-service-facet", "Errors: service facet", "/errors", (page) =>
			page.getByRole("checkbox", { name: "payment-svc" }).click(),
		),
		interaction("metrics-type-facet", "Metrics: type facet", "/metrics", (page) =>
			page.getByRole("checkbox", { name: "Gauge" }).click(),
		),
		interaction("metrics-open", "Metrics: open a metric", "/metrics", (page) =>
			page.getByRole("link", { name: /^http\.server\.request\.duration/ }).click(),
		),
		interaction("trace-detail-waterfall", "Trace detail: Waterfall tab", "/traces/0eab694ff33721d5a836ce7444afadcc", (page) =>
			page.getByRole("tab", { name: "Waterfall" }).click(),
		),
		interaction("trace-detail-flow", "Trace detail: Flow tab", "/traces/0eab694ff33721d5a836ce7444afadcc", (page) =>
			page.getByRole("tab", { name: "Flow" }).click(),
		),
		interaction("trace-detail-span", "Trace detail: open a span", "/traces/0eab694ff33721d5a836ce7444afadcc", (page) =>
			page.getByText("INSERT shop.payments").first().click(),
		),
		// The span of a `ConnectionTimeout` error log, whose Logs tab lists it.
		interaction("trace-detail-span-log", "Trace detail: open a span's log", "/traces/6843a8853182b32339b2dd5120d423f2?spanId=5649cc1dd6f78f8c", async (page) => {
			await page.getByRole("tab", { name: /^Logs/ }).click()
			await page.getByRole("tabpanel", { name: /^Logs/ }).getByRole("button").first().click()
		}),
		// Every `/local/query` is held, so the run is still in flight when Cancel aborts it.
		{
			...interaction("query-cancel", "Query: cancel a run", "/query?sql=SELECT%201", async (page) => {
				await page.getByRole("button", { name: "Run" }).click()
				await page.getByRole("button", { name: "Cancel" }).click()
			}),
			faults: { delays: { "local.query": 60_000 } },
		},
		{
			...interaction("query-table", "Query: run a table", "/query", async (page) => {
				await page.getByRole("button", { name: /^traces / }).click()
				await page.getByRole("button", { name: "Run" }).click()
			}),
			// The elapsed time is the browser's wall clock (`performance.now()`), not the frozen one.
			mask: (page) => [page.getByText(/^\d+ ms$/)],
		},
		// Reload in the same minute refetches in place: the list, the facets, the server status and
		// (the empty state is on screen) the signal presence.
		{
			...interaction("traces-empty-reload", "Traces: Reload on an empty store", "/traces", async (page) => {
				await page.getByRole("button", { name: "Reload" }).click()
				await page.waitForTimeout(DEBOUNCE_MS)
			}),
			dataset: "local-empty",
		},
		interaction("connect-open", "Connect popover", "/traces", (page) =>
			page.getByRole("button", { name: "Connect your app" }).click(),
		),
		interaction("sidebar-collapse", "Sidebar collapsed", "/traces", (page) => page.keyboard.press("ControlOrMeta+b")),
		interaction("service-map-focus", "Service map: focus", "/service-map", (page) =>
			typeInto(page, "Focus a service…", "payment"),
		),
		interaction("service-map-drag", "Service map: storefront dragged", "/service-map", (page) =>
			dragNode(page, "storefront", 40, 160),
		),
		interaction("service-map-resort", "Service map: a drag undone by Re-sort", "/service-map", async (page) => {
			await dragNode(page, "storefront", 40, 160)
			await page.getByRole("button", { name: "Re-sort" }).click()
		}),
		// The finished drag is saved (`maple-local:service-map.layout`), so a reload keeps it.
		interaction("service-map-drag-persisted", "Service map: a drag kept across a reload", "/service-map", async (page) => {
			await dragNode(page, "storefront", 40, 160)
			await page.waitForTimeout(MAP_SETTLE_MS)
			await page.reload()
			await page.getByRole("application").waitFor()
		}),
	],
}
