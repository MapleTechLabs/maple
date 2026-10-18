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

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const persistenceFailure = {
	status: 503,
	body: {
		_tag: "@maple/http/errors/IntegrationsPersistenceError",
		message: "ui-parity: injected integrations failure",
	},
}

const timed = (
	id: string,
	title: string,
	path: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
): Scenario => ({ ...page(id, title, path), faults, settle })

export const integrationsArea: AreaModule = {
	area: "integrations",
	scenarios: [
		page("hub", "Integrations hub", "/integrations"),
		page("hub-empty", "Integrations hub (empty org)", "/integrations", { dataset: "empty" }),
		timed(
			"hub-loading",
			"Hub: statuses loading",
			"/integrations",
			{
				delays: {
					"integrations.hazelStatus": HELD_MS,
					"integrations.githubStatus": HELD_MS,
					"scrapeTargets.list": HELD_MS,
				},
			},
			"held",
		),
		timed(
			"hub-error",
			"Hub: a status read failing",
			"/integrations",
			{ failures: { "integrations.hazelStatus": persistenceFailure } },
			"quiet",
		),
		timed(
			"hazel-error",
			"Hazel: status failing",
			"/integrations?integration=hazel",
			{ failures: { "integrations.hazelStatus": persistenceFailure } },
			"quiet",
		),
		timed(
			"hazel-loading",
			"Hazel: status loading",
			"/integrations?integration=hazel",
			{ delays: { "integrations.hazelStatus": HELD_MS } },
			"held",
		),
		page("github", "GitHub card", "/integrations?integration=github"),
		page("github-refresh", "GitHub: refresh", "/integrations?integration=github", {
			steps: (page) => page.getByRole("button", { name: "Refresh" }).click(),
		}),
		page("github-ci-traces", "GitHub: turn CI traces off", "/integrations?integration=github", {
			steps: (page) => page.getByRole("switch").click(),
		}),
		page("github-branch-popover", "GitHub: open the branch picker", "/integrations?integration=github", {
			steps: (page) => page.getByRole("button", { name: /branch/ }).click(),
		}),
		page("github-branch-change", "GitHub: track another branch", "/integrations?integration=github", {
			steps: async (page) => {
				await page.getByRole("button", { name: /branch/ }).click()
				await page.getByRole("button", { name: "release" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Track branch" }).click()
			},
		}),
		page("github-manage", "GitHub: manage (OAuth popup)", "/integrations?integration=github", {
			steps: (page) => page.getByRole("button", { name: "Manage" }).click(),
		}),
		page("github-disconnect", "GitHub: disconnect", "/integrations?integration=github", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Disconnect" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
			},
		}),
		page("github-empty", "GitHub (not connected)", "/integrations?integration=github", {
			dataset: "empty",
		}),
		page("github-connect", "GitHub: connect", "/integrations?integration=github", {
			dataset: "empty",
			steps: (page) => page.getByRole("button", { name: "Connect GitHub" }).last().click(),
		}),
		timed(
			"github-error",
			"GitHub: status failing",
			"/integrations?integration=github",
			{ failures: { "integrations.githubStatus": persistenceFailure } },
			"quiet",
		),
		timed(
			"github-loading",
			"GitHub: status loading",
			"/integrations?integration=github",
			{ delays: { "integrations.githubStatus": HELD_MS } },
			"held",
		),
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
		page("slack-unlink", "Slack: unlink your account", "/integrations?integration=chat-slack", {
			steps: (page) => page.getByRole("button", { name: "Unlink" }).click(),
		}),
		page("slack-add-workspace", "Slack: add another workspace", "/integrations?integration=chat-slack", {
			steps: (page) => page.getByRole("button", { name: "Add another workspace" }).click(),
		}),
		page("slack-disconnect-dialog", "Slack: confirm disconnect", "/integrations?integration=chat-slack", {
			steps: (page) => page.getByRole("button", { name: "Disconnect" }).click(),
		}),
		page("slack-disconnect", "Slack: disconnect the workspace", "/integrations?integration=chat-slack", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Disconnect" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
			},
		}),
		page("slack-empty", "Slack (not connected)", "/integrations?integration=chat-slack", {
			dataset: "empty",
		}),
		page("discord", "Discord (not connected)", "/integrations?integration=chat-discord"),
		page("discord-install", "Discord: start the install", "/integrations?integration=chat-discord", {
			steps: (page) => page.getByRole("button", { name: "Add to Discord" }).click(),
		}),
		timed(
			"slack-loading",
			"Slack: connectors loading",
			"/integrations?integration=chat-slack",
			{ delays: { "chatIntegration.connectors": HELD_MS } },
			"held",
		),
		page("hazel", "Hazel card", "/integrations?integration=hazel"),
		page("back", "Card: back to the hub", "/integrations?integration=hazel", {
			steps: (page) => page.getByRole("button", { name: "Back to integrations" }).click(),
		}),
		page("hazel-empty", "Hazel (not connected)", "/integrations?integration=hazel", { dataset: "empty" }),
		page("hazel-connect", "Hazel: start the OAuth connect", "/integrations?integration=hazel", {
			dataset: "empty",
			steps: (page) => page.getByRole("button", { name: "Connect Hazel" }).last().click(),
		}),
		page("hazel-disconnect-dialog", "Hazel: confirm disconnect", "/integrations?integration=hazel", {
			steps: (page) => page.getByRole("button", { name: "Disconnect" }).click(),
		}),
		page("hazel-disconnect", "Hazel: disconnect", "/integrations?integration=hazel", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Disconnect" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
			},
		}),
		page("cloudflare", "Cloudflare (not connected)", "/integrations?integration=cloudflare"),
		page("cloudflare-connect", "Cloudflare: connect", "/integrations?integration=cloudflare", {
			steps: (page) => page.getByRole("button", { name: "Connect Cloudflare" }).last().click(),
		}),
		page("cloudflare-connected", "Cloudflare (connected)", "/integrations?integration=cloudflare", {
			dataset: "infra-integrations",
		}),
		page("cloudflare-disconnect", "Cloudflare: disconnect", "/integrations?integration=cloudflare", {
			dataset: "infra-integrations",
			steps: async (page) => {
				await page.getByRole("button", { name: "Disconnect" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
			},
		}),
		page("cloudflare-reconnect", "Cloudflare: reconnect", "/integrations?integration=cloudflare", {
			dataset: "infra-integrations",
			steps: (page) => page.getByRole("button", { name: "Reconnect" }).click(),
		}),
		page("hub-infra", "Hub with infrastructure connected", "/integrations", {
			dataset: "infra-integrations",
		}),
		timed(
			"cloudflare-error",
			"Cloudflare: status failing",
			"/integrations?integration=cloudflare",
			{ failures: { "integrations.cloudflareStatus": persistenceFailure } },
			"quiet",
		),
		timed(
			"cloudflare-loading",
			"Cloudflare: status loading",
			"/integrations?integration=cloudflare",
			{ delays: { "integrations.cloudflareStatus": HELD_MS } },
			"held",
		),
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
