import type { Page } from "playwright"
import { checkBox, clickButton, clickLink, EMPTY, opsScenarios, act, WEB } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Web analytics over the storefront's browser sessions (`acme-web`). */
const analytics = opsScenarios("analytics", "Web analytics")
const HELD_MS = 60_000
const injected = {
	status: 502,
	body: {
		_tag: "@maple/http/errors/QueryEngineExecutionError",
		message: "ui-parity: injected web analytics failure",
	},
}

const exactButton = (name: string) => (page: Page) => page.getByRole("button", { name, exact: true }).first().click()
const expandFirst = (page: Page) => page.getByRole("button", { name: /Expand table/ }).first().click()

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
		analytics("metric-bounce", "Bounce rate picked in the strip", "/analytics", {
			dataset: WEB,
			steps: act(clickButton(/^Bounce rate/)),
		}),
		analytics("panel-tab", "Browsers tab of the technology card", "/analytics", {
			dataset: WEB,
			steps: act(exactButton("Browsers")),
		}),
		analytics("panel-search", "Referrers card searched", "/analytics", {
			dataset: WEB,
			steps: act((page) => page.getByPlaceholder("Filter referrers").first().fill("news")),
		}),
		analytics("panel-sort", "Referrers card sorted by name", "/analytics", {
			dataset: WEB,
			steps: act(exactButton("Referrer")),
		}),
		analytics("row-filter", "Filtered from a referrer row", "/analytics", {
			dataset: WEB,
			steps: act((page) => page.getByRole("button", { name: /www\.reddit\.com/ }).first().click()),
		}),
		analytics("expand", "Referrers table expanded", "/analytics", {
			dataset: WEB,
			steps: act(expandFirst),
		}),
		analytics("expand-row", "Filtered from the expanded table", "/analytics", {
			dataset: WEB,
			steps: act(expandFirst, (page) =>
				page.getByRole("dialog").getByRole("button", { name: /www\.google\.com/ }).first().click(),
			),
		}),
		analytics("traffic-bots", "Bots included", "/analytics", {
			dataset: WEB,
			steps: act(checkBox("Bots")),
		}),
		analytics("chip-remove", "Filter chip removed", "/analytics?pagePath=%2Fcart&country=US", {
			dataset: WEB,
			steps: act(clickButton(/^page:\/cart/)),
		}),
		analytics("clear-all", "Filters cleared from the chip row", "/analytics?pagePath=%2Fcart&country=US", {
			dataset: WEB,
			steps: act(clickButton("Clear all")),
		}),
		analytics("reload", "Reloaded", "/analytics", {
			dataset: WEB,
			steps: act(clickButton("Reload")),
		}),
		analytics("ai-expand", "AI traffic, a table expanded", "/analytics?tab=ai", {
			dataset: WEB,
			steps: act(expandFirst),
		}),
		analytics("ai-filtered", "AI traffic filtered to a country", "/analytics?tab=ai&country=US", { dataset: WEB }),
		analytics("loading", "Loading (summary and breakdowns held)", "/analytics", {
			dataset: WEB,
			faults: {
				delays: { "queryEngine.webAnalyticsSummary": HELD_MS, "queryEngine.webAnalyticsBreakdowns": HELD_MS },
			},
			settle: "held",
		}),
		analytics("ai-loading", "AI traffic loading", "/analytics?tab=ai", {
			dataset: WEB,
			faults: {
				delays: { "queryEngine.webAnalyticsAiReferrals": HELD_MS, "queryEngine.webAnalyticsAiCrawlers": HELD_MS },
			},
			settle: "held",
		}),
		analytics("error", "Summary and breakdowns failing", "/analytics", {
			dataset: WEB,
			faults: {
				failures: { "queryEngine.webAnalyticsSummary": injected, "queryEngine.webAnalyticsBreakdowns": injected },
			},
		}),
	],
}
