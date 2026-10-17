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
		logs("row-expanded", "the first row expanded", async (page) => {
			await stream(page).getByRole("button", { name: "Expand log" }).first().click()
			await page.mouse.move(5, 5)
		}),
	],
}
