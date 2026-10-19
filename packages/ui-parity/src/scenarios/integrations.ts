import type { Page } from "playwright"
import { gcpConfigureScenarios } from "./integrations-gcp-configure.ts"
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

/** The same failure on a v2 endpoint, in its public error envelope. */
const v2PersistenceFailure = {
	status: 503,
	body: {
		error: {
			_tag: "@maple/http/errors/IntegrationsPersistenceError",
			type: "api_error",
			code: "integration_persistence_unavailable",
			title: "Integrations are temporarily unavailable",
			message: "Integrations are temporarily unavailable. Retry in a few seconds.",
			retryable: true,
			recovery: "retry",
		},
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
		page(
			"prometheus-add-dialog",
			"Prometheus: the add-target dialog",
			"/integrations?integration=prometheus",
			{
				steps: (page) => page.getByRole("button", { name: "Add target" }).first().click(),
			},
		),
		page("prometheus-add", "Prometheus: add a target", "/integrations?integration=prometheus", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Add target" }).first().click()
				const dialog = page.getByRole("dialog")
				await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("node exporter")
				await dialog
					.getByRole("textbox", { name: "URL", exact: true })
					.fill("https://node.shop.internal:9100/metrics")
				await dialog.getByRole("button", { name: "Add target" }).click()
			},
		}),
		page("prometheus-edit", "Prometheus: edit a target", "/integrations?integration=prometheus", {
			steps: async (page) => {
				await page.getByText("redis exporter").first().click()
				await page.getByRole("button", { name: "Edit" }).click()
				await page
					.getByRole("dialog")
					.getByRole("textbox", { name: "Service name" })
					.fill("cache-svc")
				await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click()
			},
		}),
		page(
			"prometheus-auth-basic",
			"Prometheus: basic auth fields",
			"/integrations?integration=prometheus",
			{
				steps: async (page) => {
					await page.getByRole("button", { name: "Add target" }).first().click()
					await page.getByRole("dialog").getByRole("combobox").click()
					await page.getByRole("option", { name: "Basic Auth" }).click()
				},
			},
		),
		page("prometheus-probe", "Prometheus: test a target", "/integrations?integration=prometheus", {
			steps: (page) => page.getByRole("button", { name: "Test" }).first().click(),
		}),
		page("prometheus-toggle", "Prometheus: disable a target", "/integrations?integration=prometheus", {
			steps: (page) => page.getByRole("switch").first().click(),
		}),
		page(
			"prometheus-row-menu",
			"Prometheus: a target's actions menu",
			"/integrations?integration=prometheus",
			{
				steps: (page) =>
					page.getByRole("button", { name: "Actions for redis exporter", exact: true }).click(),
			},
		),
		page("prometheus-delete", "Prometheus: delete a target", "/integrations?integration=prometheus", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Actions for redis exporter", exact: true }).click()
				await page.getByRole("menuitem", { name: "Delete" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
			},
		}),
		page("warpstream", "WarpStream (scrape targets)", "/integrations?integration=warpstream"),
		timed(
			"prometheus-loading",
			"Prometheus: targets loading",
			"/integrations?integration=prometheus",
			{ delays: { "scrapeTargets.list": HELD_MS } },
			"held",
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
		page(
			"cloudflare-zone-filter",
			"Cloudflare: filter zones to Live",
			"/integrations?integration=cloudflare",
			{
				dataset: "infra-integrations",
				steps: (page) => page.getByRole("button", { name: /^Live/ }).click(),
			},
		),
		page(
			"cloudflare-zone-sort",
			"Cloudflare: sort zones by name",
			"/integrations?integration=cloudflare",
			{
				dataset: "infra-integrations",
				steps: (page) => page.getByRole("button", { name: "Zone", exact: true }).click(),
			},
		),
		page("cloudflare-zone-search", "Cloudflare: search zones", "/integrations?integration=cloudflare", {
			dataset: "infra-integrations",
			steps: (page) => page.getByRole("textbox", { name: "Filter zones by name" }).fill("nomatch"),
		}),
		page("railway", "Railway (not connected)", "/integrations?integration=railway"),
		page("railway-connect", "Railway: connect with a token", "/integrations?integration=railway", {
			steps: async (page) => {
				await page.getByLabel("Account or workspace token").fill("rw_token_parity_0001")
				await page.getByRole("button", { name: "Connect Railway" }).last().click()
			},
		}),
		page("railway-connected", "Railway (connected)", "/integrations?integration=railway", {
			dataset: "infra-integrations",
		}),
		page("railway-sync", "Railway: sync now", "/integrations?integration=railway", {
			dataset: "infra-integrations",
			steps: (page) => page.getByRole("button", { name: "Sync now" }).click(),
		}),
		page("railway-rotate", "Railway: replace the token", "/integrations?integration=railway", {
			dataset: "infra-integrations",
			steps: (page) => page.getByRole("button", { name: "Replace token" }).click(),
		}),
		page("railway-disconnect", "Railway: disconnect", "/integrations?integration=railway", {
			dataset: "infra-integrations",
			steps: async (page) => {
				await page.getByRole("button", { name: "Disconnect" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
			},
		}),
		timed(
			"railway-error",
			"Railway: status failing",
			"/integrations?integration=railway",
			{ failures: { "integrations.railwayStatus": persistenceFailure } },
			"quiet",
		),
		page("planetscale", "PlanetScale (not connected)", "/integrations?integration=planetscale"),
		page("planetscale-connect", "PlanetScale: connect", "/integrations?integration=planetscale", {
			steps: (page) => page.getByRole("button", { name: "Connect PlanetScale" }).last().click(),
		}),
		page("planetscale-connected", "PlanetScale (connected)", "/integrations?integration=planetscale", {
			dataset: "infra-integrations",
		}),
		page(
			"planetscale-change-org",
			"PlanetScale: change organization",
			"/integrations?integration=planetscale",
			{
				dataset: "infra-integrations",
				steps: (page) => page.getByRole("button", { name: "Change organization" }).click(),
			},
		),
		page(
			"planetscale-change-org-submit",
			"PlanetScale: switch to another organization",
			"/integrations?integration=planetscale",
			{
				dataset: "infra-integrations",
				steps: async (page) => {
					await page.getByRole("button", { name: "Change organization" }).click()
					await page.getByRole("radio", { name: "acme-labs" }).check({ force: true })
					await page.getByRole("button", { name: "Connect organization" }).click()
				},
			},
		),
		page(
			"planetscale-rotate",
			"PlanetScale: rotate the metrics token",
			"/integrations?integration=planetscale",
			{
				dataset: "infra-integrations",
				steps: (page) => page.getByRole("button", { name: "Rotate token" }).click(),
			},
		),
		page(
			"planetscale-rotate-submit",
			"PlanetScale: save a new metrics token",
			"/integrations?integration=planetscale",
			{
				dataset: "infra-integrations",
				steps: async (page) => {
					await page.getByRole("button", { name: "Rotate token" }).click()
					await page.getByRole("textbox", { name: "Service token ID" }).fill("tok_parity")
					await page.getByLabel("Service token secret").fill("pscale_tkn_parity")
					await page.getByRole("button", { name: "Update token" }).click()
				},
			},
		),
		page("planetscale-webhook", "PlanetScale: webhook setup", "/integrations?integration=planetscale", {
			dataset: "infra-integrations",
			steps: (page) => page.getByRole("button", { name: "Show setup" }).click(),
		}),
		page("gcp", "Google Cloud (not connected)", "/integrations?integration=gcp"),
		page("gcp-connected", "Google Cloud (connected)", "/integrations?integration=gcp", {
			dataset: "infra-integrations",
		}),
		page("gcp-menu", "Google Cloud: a connection's menu", "/integrations?integration=gcp", {
			dataset: "infra-integrations",
			steps: (page) => page.getByRole("button", { name: /^Actions for / }).click(),
		}),
		page(
			"gcp-disconnect-dialog",
			"Google Cloud: the disconnect dialog",
			"/integrations?integration=gcp",
			{
				dataset: "infra-integrations",
				steps: async (page) => {
					await page.getByRole("button", { name: /^Actions for / }).click()
					await page.getByRole("menuitem", { name: "Disconnect" }).click()
					await page.getByRole("button", { name: "Read the script" }).click()
				},
			},
		),
		page("gcp-disconnect-console", "Google Cloud: delete in the console instead", "/integrations?integration=gcp", {
			dataset: "infra-integrations",
			steps: async (page) => {
				await page.getByRole("button", { name: /^Actions for / }).click()
				await page.getByRole("menuitem", { name: "Disconnect" }).click()
				await page.getByText("Delete them in the console instead").click()
			},
		}),
		page("gcp-disconnect-submit", "Google Cloud: disconnect anyway", "/integrations?integration=gcp", {
			dataset: "infra-integrations",
			steps: async (page) => {
				await page.getByRole("button", { name: /^Actions for / }).click()
				await page.getByRole("menuitem", { name: "Disconnect" }).click()
				await page.getByRole("button", { name: "Disconnect anyway" }).click()
				await page.getByRole("button", { name: "Dismiss" }).waitFor()
			},
		}),
		page("gcp-dismiss", "Google Cloud: dismiss a cleanup script", "/integrations?integration=gcp", {
			dataset: "infra-integrations",
			steps: async (page) => {
				await page.getByRole("button", { name: /^Actions for / }).click()
				await page.getByRole("menuitem", { name: "Disconnect" }).click()
				await page.getByRole("button", { name: "Disconnect anyway" }).click()
				await page.getByRole("button", { name: "Dismiss" }).click()
				await page.getByRole("alertdialog").getByRole("button", { name: "Dismiss" }).click()
			},
		}),
		timed(
			"gcp-error",
			"Google Cloud: status failing",
			"/integrations?integration=gcp",
			{ failures: { "gcpIntegration.status": v2PersistenceFailure } },
			"quiet",
		),
		timed(
			"gcp-loading",
			"Google Cloud: status loading",
			"/integrations?integration=gcp",
			{ delays: { "gcpIntegration.status": HELD_MS } },
			"held",
		),
		{
			...page(
				"gcp-disconnect-failure",
				"Google Cloud: disconnect fails",
				"/integrations?integration=gcp",
				{
					dataset: "infra-integrations",
					steps: async (page) => {
						await page.getByRole("button", { name: /^Actions for / }).click()
						await page.getByRole("menuitem", { name: "Disconnect" }).click()
						await page.getByRole("button", { name: "Disconnect anyway" }).click()
						await page.getByText("Failed to disconnect").waitFor()
					},
				},
			),
			faults: { failures: { "gcpIntegration.deleteConnector": v2PersistenceFailure } },
		},
		page("gcp-view-logs", "Google Cloud: View logs from the menu", "/integrations?integration=gcp", {
			dataset: "infra-integrations",
			steps: async (page) => {
				await page.getByRole("button", { name: /^Actions for / }).click()
				await page.getByRole("menuitem", { name: "View logs" }).click()
				await page.waitForURL(/\/logs/)
			},
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
		...gcpConfigureScenarios,
	],
}
