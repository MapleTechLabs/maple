import type { Page } from "playwright"
import { checkBox, clickButton, EMPTY, opsScenarios, SEEDED, act, WEB } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"

/** Session replays: the storefront's sessions and Maria's failed checkout, recorded inline. */
const replay = opsScenarios("replays", "Replays")
const checkout = `/replays/${SEEDED.checkoutReplay}`
const HELD_MS = 60_000
const injected = {
	status: 502,
	body: {
		_tag: "@maple/http/errors/QueryEngineExecutionError",
		message: "ui-parity: injected session replays failure",
	},
}

/** `/lab/replays`: the list over a day of mostly low-signal sessions, no warehouse behind it. */
const listLab = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	id: `lab-replays-${id}`,
	title: `Lab: session replays list, ${title}`,
	path: "/lab/replays",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps: act(steps),
	area: "replays",
})

export const replaysArea: AreaModule = {
	area: "replays",
	scenarios: [
		replay("list", "Last 24 hours", "/replays", { dataset: WEB }),
		replay("list-signed-in", "Filtered to signed-in sessions", "/replays", {
			dataset: WEB,
			steps: act(checkBox("Signed in")),
		}),
		replay("detail", "Failed checkout session", checkout, { dataset: WEB }),
		replay("detail-errors", "Failed checkout, errors only", checkout, {
			dataset: WEB,
			steps: act(clickButton(/^Errors \(/)),
		}),
		replay("detail-session", "Failed checkout, session tab", checkout, {
			dataset: WEB,
			steps: act(clickButton(/^Session$/)),
		}),
		replay("list-empty", "Replays (empty org)", "/replays", { dataset: EMPTY }),
		replay("list-loading", "loading (list and facets held)", "/replays", {
			dataset: WEB,
			faults: { delays: { "sessionReplays.search": HELD_MS, "sessionReplaysInternal.facets": HELD_MS } },
			settle: "held",
		}),
		replay("list-error", "list and facets failing", "/replays", {
			dataset: WEB,
			faults: { failures: { "sessionReplays.search": injected, "sessionReplaysInternal.facets": injected } },
		}),
		replay("list-browser", "Safari only, from the sidebar", "/replays", {
			dataset: WEB,
			steps: act(checkBox("Safari")),
		}),
		replay("list-errors-chip", "errors chip pressed", "/replays", {
			dataset: WEB,
			steps: act(clickButton(/with errors/)),
		}),
		replay("list-engaged-chip", "engaged chip pressed", "/replays", {
			dataset: WEB,
			steps: act(clickButton(/engaged$/)),
		}),
		replay("list-bounced", "the Bounced session length preset", "/replays", {
			dataset: WEB,
			steps: act(clickButton(/^Bounced/)),
		}),
		replay("list-search", "searched by URL", "/replays", {
			dataset: WEB,
			steps: act(async (page) => {
				await page.getByRole("textbox", { name: "Search by URL…" }).fill("cart")
				await page.waitForTimeout(600)
			}),
		}),
		replay("list-row-tag", "filtered by a row's tag pill", "/replays", {
			dataset: WEB,
			steps: act(clickButton("New visitor")),
		}),
		replay("list-user-id", "user ID submitted from the sidebar", "/replays", {
			dataset: WEB,
			steps: act(async (page) => {
				await page.getByRole("textbox", { name: "User ID" }).fill("kenji@example.com")
				await page.getByRole("textbox", { name: "User ID" }).press("Enter")
				await page.getByText("Sessions from", { exact: true }).waitFor()
			}),
		}),
		replay("list-time-range", "last 6 hours from the time range picker", "/replays", {
			dataset: WEB,
			steps: act(async (page) => {
				await page.getByRole("button", { name: "Last 24 hours" }).click()
				await page.getByRole("dialog").getByRole("button", { name: "Last 6 hours" }).click()
				await page.getByRole("dialog").waitFor({ state: "detached" })
			}),
		}),
		replay("list-open-session", "a row opened", "/replays", {
			dataset: WEB,
			steps: act(async (page) => {
				await page.getByText("Maria Garcia").first().click()
				await page.waitForURL(/\/replays\/.+/)
			}),
		}),
		listLab("expand-run", "a low-signal run expanded", clickButton(/^5 low-signal sessions/)),
		listLab("tag-filter", "filtered by a tag pill, then cleared", async (page) => {
			await clickButton("Signed in")(page)
			await clickButton(/^Clear signed_in/)(page)
		}),
		listLab("org-filter", "filtered by an org", clickButton("Superwall")),
		listLab("errors-only", "errors chip pressed", clickButton(/with errors/)),
		listLab("engaged-only", "engaged chip pressed", clickButton(/engaged$/)),
		listLab("narrow", "700px wide", clickButton("700px")),
	],
}
