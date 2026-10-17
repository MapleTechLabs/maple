import { checkBox, clickButton, EMPTY, opsScenarios, SEEDED, act, WEB } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Session replays: the storefront's sessions and Maria's failed checkout, recorded inline. */
const replay = opsScenarios("replays", "Replays")
const checkout = `/replays/${SEEDED.checkoutReplay}`

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
	],
}
