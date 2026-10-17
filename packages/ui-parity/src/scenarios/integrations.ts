import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** The /integrations hub, one card per connected kind, and the /connectors redirect. */

const page = (
	id: string,
	title: string,
	path: string,
	options: { readonly dataset?: string; readonly steps?: (page: Page) => Promise<void> } = {},
): Scenario => ({
	id: `integrations-${id}`,
	title,
	path,
	dataset: options.dataset ?? "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps: options.steps,
	area: "integrations",
})

export const integrationsArea: AreaModule = {
	area: "integrations",
	scenarios: [
		page("hub", "Integrations hub", "/integrations"),
		page("hub-empty", "Integrations hub (empty org)", "/integrations", { dataset: "empty" }),
		page("github", "GitHub card", "/integrations?integration=github"),
		page("prometheus", "Prometheus scrape targets", "/integrations?integration=prometheus"),
		page(
			"prometheus-checks",
			"Prometheus: inspect a failing target",
			"/integrations?integration=prometheus",
			{
				steps: (page) => page.getByText("redis exporter").first().click(),
			},
		),
		page("prometheus-empty", "Prometheus (no targets)", "/integrations?integration=prometheus", {
			dataset: "empty",
		}),
		page("slack", "Slack workspace", "/integrations?integration=chat-slack"),
		page("hazel", "Hazel card", "/integrations?integration=hazel"),
		page("cloudflare", "Cloudflare (not connected)", "/integrations?integration=cloudflare"),
		page("open-card", "Hub: open the Prometheus card", "/integrations", {
			steps: (page) =>
				page
					.getByRole("button", { name: /Prometheus/ })
					.first()
					.click(),
		}),
		page("connectors", "Connectors (redirects to the hub)", "/connectors?tab=prometheus"),
	],
}
