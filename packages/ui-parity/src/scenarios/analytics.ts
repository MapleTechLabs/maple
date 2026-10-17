import { checkBox, clickLink, EMPTY, opsScenarios, act, WEB } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Web analytics over the storefront's browser sessions (`acme-web`). */
const analytics = opsScenarios("analytics", "Web analytics")

export const analyticsArea: AreaModule = {
	area: "analytics",
	scenarios: [
		analytics("overview", "Last 7 days", "/analytics", { dataset: WEB }),
		analytics("filtered", "Filtered to the cart page", "/analytics", {
			dataset: WEB,
			steps: act(checkBox("/cart")),
		}),
		analytics("ai-traffic", "AI traffic tab", "/analytics", {
			dataset: WEB,
			steps: act(clickLink("AI traffic")),
		}),
		analytics("empty", "Web analytics (empty org)", "/analytics", { dataset: EMPTY }),
	],
}
