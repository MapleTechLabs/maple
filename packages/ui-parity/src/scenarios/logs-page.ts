import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * `/logs` on dataset `default`: loading and error states, the empties, and the interactions the
 * stream page adds on top of the S4 table (filters, toolbar, row expand, detail sheet, menus).
 */
const logs = (
	id: string,
	title: string,
	steps: ((page: Page) => Promise<void>) | undefined,
	path = "/logs",
): Scenario => ({
	id: `logs-${id}`,
	title: `Logs: ${title}`,
	path,
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	area: "logs",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const injected = (tag: string, message: string) => ({
	status: 502,
	body: { _tag: tag, message },
})

const timed = (
	id: string,
	title: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
): Scenario => ({
	...logs(id, title, undefined),
	faults,
	settle,
})

const stream = (page: Page) => page.getByRole("log")

/** The first log's Infrastructure tab (acme logs carry their pod and node). */
const openInfraTab = async (page: Page) => {
	await stream(page).getByRole("listitem").first().click()
	await page.getByRole("tab", { name: "Infrastructure" }).click()
	await page.getByRole("dialog").getByText("View in Infrastructure").first().waitFor()
	await page.mouse.move(5, 5)
}

export const logsPageArea: AreaModule = {
	area: "logs",
	scenarios: [
		timed(
			"loading",
			"loading (list and execute-batch held)",
			{ delays: { "queryEngine.executeBatch": HELD_MS, "queryEngine.listLogs": HELD_MS } },
			"held",
		),
		timed(
			"error",
			"list and execute-batch failing",
			{
				failures: {
					"queryEngine.executeBatch": injected(
						"@maple/http/errors/QueryEngineExecutionError",
						"ui-parity: injected execute-batch failure",
					),
					"queryEngine.listLogs": injected(
						"@maple/http/errors/QueryEngineExecutionError",
						"ui-parity: injected list-logs failure",
					),
				},
			},
			"quiet",
		),
		logs("search-empty", "a search nothing matches", undefined, "/logs?search=%22zz-no-such-log%22"),
		logs(
			"filtered-empty",
			"a service filter nothing matches",
			undefined,
			"/logs?services=%5B%22no-such-svc%22%5D",
		),
		logs("wrap-comfortable", "wrapped lines, comfortable rows", async (page) => {
			await page.getByRole("button", { name: "Wrap long log lines" }).click()
			await page.getByRole("button", { name: "Toggle comfortable row density" }).click()
			await page.mouse.move(5, 5)
		}),
		logs("severity-filter", "WARN only, from the sidebar", async (page) => {
			await page.getByRole("checkbox", { name: "WARN", exact: true }).click()
			await page.getByText("Severity", { exact: true }).last().waitFor()
			await page.mouse.move(5, 5)
		}),
		logs("refresh-menu", "the auto-refresh menu open", async (page) => {
			await page.getByRole("button", { name: "Auto-refresh off" }).click()
			await page.getByRole("menu").waitFor()
		}),
		logs(
			"live-paused",
			"a live tail held while the pointer is over the stream",
			async (page) => {
				await stream(page).hover({ position: { x: 120, y: 120 } })
				await page.getByText("Paused while you inspect").waitFor()
			},
			"/logs?refresh=30",
		),
		logs("columns-popover", "the Columns picker open", async (page) => {
			await page.getByRole("button", { name: "Pin attributes as columns" }).click()
			await page.getByRole("dialog").waitFor()
		}),
		logs("toolbar-tooltip", "the wrap toggle's tooltip", async (page) => {
			await page.getByRole("button", { name: "Wrap long log lines" }).hover()
			await page.getByText("Wrap long lines", { exact: true }).waitFor()
		}),
		logs("search-help", "the search help popover", async (page) => {
			await page.getByRole("button", { name: "What you can search for" }).hover()
			await page.getByRole("dialog").waitFor()
		}),
		logs("detail-sheet", "a row opened in the detail sheet", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page.getByRole("dialog").waitFor()
		}),
		logs("row-expanded", "the first row expanded", async (page) => {
			await stream(page).getByRole("button", { name: "Expand log" }).first().click()
			await page.mouse.move(5, 5)
		}),
		logs("search-text", "typing a body search (debounced into the URL)", async (page) => {
			await page.getByPlaceholder("Text or trace id").fill("pool")
			await page.getByText("matching", { exact: false }).last().waitFor()
			await page.mouse.move(5, 5)
		}),
		logs("search-trace", "pasting a trace id scopes the stream", async (page) => {
			await page.getByPlaceholder("Text or trace id").fill("0eab694ff33721d5a836ce7444afadcc")
			await page.getByText("Trace", { exact: true }).first().waitFor()
			await page.mouse.move(5, 5)
		}),
		logs(
			"chip-remove",
			"removing a filter chip",
			async (page) => {
				await page.getByRole("button", { name: /^Remove filter: Severity/ }).click()
				await page.getByRole("log").waitFor()
				await page.mouse.move(5, 5)
			},
			"/logs?severities=%5B%22WARN%22%5D",
		),
		logs("service-only", "Only one service, from the sidebar", async (page) => {
			await page.getByText("auth-svc", { exact: true }).first().hover()
			await page.getByRole("button", { name: "Show only auth-svc" }).click()
			await page.getByText("Service is", { exact: false }).waitFor()
			await page.mouse.move(5, 5)
		}),
		logs("service-exclude", "a service excluded, from the sidebar", async (page) => {
			await page.getByText("storefront", { exact: true }).first().hover()
			await page.getByRole("button", { name: "Exclude storefront" }).click()
			await page.getByText("Service is not", { exact: false }).waitFor()
			await page.mouse.move(5, 5)
		}),
		logs("time-range", "last 1 day from the time range picker", async (page) => {
			await page.getByRole("button", { name: "Last 12 hours" }).click()
			await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
			await page.getByRole("dialog").waitFor({ state: "detached" })
			await page.mouse.move(5, 5)
		}),
		logs("reload", "Reload re-reads the window", async (page) => {
			await page.getByRole("button", { name: "Reload", exact: true }).click()
			await page.waitForTimeout(800)
			await page.mouse.move(5, 5)
		}),
		logs("refresh-interval", "a 30s live tail picked from the menu", async (page) => {
			await page.getByRole("button", { name: "Auto-refresh off" }).click()
			await page.getByRole("menuitemradio", { name: "30s" }).click()
			await page.keyboard.press("Escape")
			await page.getByRole("button", { name: "Auto-refresh every 30s" }).waitFor()
			await page.mouse.move(5, 5)
		}),
		logs("column-pinned", "http.route pinned from the Columns picker", async (page) => {
			await page.getByRole("button", { name: "Pin attributes as columns" }).click()
			await page.getByRole("checkbox", { name: "http.route", exact: true }).click()
			await page.keyboard.press("Escape")
			await page.mouse.move(5, 5)
		}),
		logs("paginated", "scrolling the stream loads a later page", async (page) => {
			await stream(page).hover({ position: { x: 120, y: 120 } })
			await page.mouse.wheel(0, 14000)
			await page.waitForTimeout(800)
			await page.mouse.move(5, 5)
		}),
		logs("detail-raw", "the detail sheet's Raw tab", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page.getByRole("tab", { name: "Raw" }).click()
			await page.getByText("JSON Payload", { exact: true }).waitFor()
		}),
		logs("detail-trace", "the detail sheet's Trace tab", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page.getByRole("tab", { name: "Trace" }).click()
			await page.getByText("Trace Timeline", { exact: false }).waitFor()
			await page.getByRole("dialog").locator(".font-mono.cursor-pointer").first().waitFor()
		}),
		logs("detail-context", "the detail sheet's Context tab", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page.getByRole("tab", { name: "Context" }).click()
			await page.getByText("Surrounding logs", { exact: false }).waitFor()
			await page.getByRole("dialog").locator("li[aria-current]").waitFor()
		}),
		logs("detail-context-step", "a surrounding log opened from the Context tab", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page.getByRole("tab", { name: "Context" }).click()
			await page.getByRole("dialog").locator("li[aria-current]").waitFor()
			await page.getByRole("dialog").locator("li:not([aria-current]) button").first().click()
			await page.getByRole("dialog").locator("li[aria-current]").waitFor()
			await page.mouse.move(5, 5)
		}),
		logs(
			"detail-error",
			"an error log's banner",
			async (page) => {
				await stream(page).getByRole("listitem").first().click()
				await page.getByRole("dialog").getByRole("button", { name: "Copy error message" }).waitFor()
			},
			"/logs?severities=%5B%22ERROR%22%5D",
		),
		logs("detail-copy-json", "the Raw tab's JSON copied", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page.getByRole("tab", { name: "Raw" }).click()
			await page.getByRole("dialog").getByRole("button", { name: /Copy/ }).last().click()
			await page.getByText("Log JSON copied", { exact: true }).waitFor()
			await page.mouse.move(5, 5)
		}),
		logs("detail-page", "a log's own page, from the sheet", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page
				.getByRole("dialog")
				.getByRole("link", { name: /full page/i })
				.click()
			await page.waitForURL(/\/logs\/[^?]+$/)
			await page.getByText("Surrounding logs", { exact: false }).waitFor()
			await page.mouse.move(5, 5)
		}),
		logs(
			"jump-latest",
			"Jump to latest after scrolling a live tail down",
			async (page) => {
				await stream(page).getByRole("listitem").first().waitFor()
				await stream(page).hover({ position: { x: 120, y: 120 } })
				await page.mouse.wheel(0, 4000)
				await page.getByRole("button", { name: "Jump to latest" }).click()
				await page.getByRole("button", { name: "Jump to latest" }).waitFor({ state: "detached" })
				await page.mouse.move(5, 5)
			},
			"/logs?refresh=30",
		),
		logs(
			"page-invalid",
			"a log page whose link does not decode",
			async (page) => {
				await page.getByText("Log not found", { exact: true }).waitFor()
			},
			"/logs/not-a-log-key",
		),
		logs("detail-filter", "filtering by an attribute from the detail sheet", async (page) => {
			await stream(page).getByRole("listitem").first().click()
			await page
				.getByRole("dialog")
				.getByRole("button", { name: /^Filter by http\.route/ })
				.click()
			await page.getByText("http.route", { exact: true }).first().waitFor()
			await page.mouse.move(5, 5)
		}),
		// `infra-k8s` has the cluster's kubelet metrics; `default` has none, so its charts are empty.
		{ ...logs("detail-infra", "the detail sheet's Infrastructure tab, with metrics", openInfraTab), dataset: "infra-k8s" },
		logs("detail-infra-empty", "the Infrastructure tab of a pod with no metrics", openInfraTab),
		{
			...logs("detail-infra-loading", "the Infrastructure tab while its series load", openInfraTab),
			dataset: "infra-k8s",
			// Only the pod is held (six would fill the per-origin pool); "held" settles before the steps run.
			faults: { delays: { "queryEngine.podInfraTimeseries": HELD_MS } },
		},
	],
}
