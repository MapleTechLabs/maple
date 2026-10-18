import type { Page } from "playwright"
import { checkBox, clickButton, EMPTY, opsScenarios, SEEDED, act, WEB } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"

/** Session replays: the storefront's sessions and Maria's failed checkout, recorded inline. */
const replay = opsScenarios("replays", "Replays")
const checkout = `/replays/${SEEDED.checkoutReplay}`

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
