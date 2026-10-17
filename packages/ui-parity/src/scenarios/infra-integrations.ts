import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Infrastructure integrations on dataset `infra-integrations` (src/fixtures/areas/infra-integrations.ts):
 * Cloudflare zones, Workers and a queue, a Railway project, a Google Cloud project and two
 * PlanetScale databases, all with 24 h of poller metrics. Index pages also capture the `empty` org.
 */
const DATASET = "infra-integrations"
const EMPTY = "empty"

const scenario = (
	id: string,
	title: string,
	path: string,
	options: {
		readonly dataset?: string
		readonly steps?: (page: Page) => Promise<void>
		readonly fullPage?: boolean
	} = {},
): Scenario => ({
	id: `infra-int-${id}`,
	title,
	path,
	dataset: options.dataset ?? DATASET,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps: options.steps,
	fullPage: options.fullPage,
	area: "infra-integrations",
})

const press = (name: string) => async (page: Page) => {
	await page.getByRole("button", { name, exact: true }).click()
}

export const infraIntegrationsArea: AreaModule = {
	area: "infra-integrations",
	scenarios: [
		scenario("cloudflare", "Cloudflare: zones, Workers, queues", "/infra/cloudflare"),
		scenario("cloudflare-workers", "Cloudflare: Workers tab", "/infra/cloudflare", {
			steps: press("Workers 2"),
		}),
		scenario("cloudflare-queues", "Cloudflare: Queues tab", "/infra/cloudflare", {
			steps: press("Queues 1"),
		}),
		scenario("cloudflare-empty", "Cloudflare: not connected", "/infra/cloudflare", { dataset: EMPTY }),
		scenario("cloudflare-zone", "Cloudflare zone: acme.test", "/infra/cloudflare/acme.test"),
		scenario("cloudflare-zone-dns", "Cloudflare zone: DNS tab", "/infra/cloudflare/acme.test", {
			steps: press("DNS"),
		}),
		scenario("cloudflare-zone-security", "Cloudflare zone: Security tab", "/infra/cloudflare/acme.test", {
			steps: press("Security"),
		}),
		scenario(
			"cloudflare-worker",
			"Cloudflare Worker: edge-router",
			"/infra/cloudflare/workers/edge-router",
		),
		scenario("railway", "Railway: services", "/infra/railway"),
		scenario("railway-search", "Railway: search for postgres", "/infra/railway", {
			steps: async (page) => {
				await page.getByRole("textbox", { name: "Search services…" }).fill("postgres")
			},
		}),
		scenario("railway-empty", "Railway: not connected", "/infra/railway", { dataset: EMPTY }),
		scenario(
			"railway-service",
			"Railway service: api (production)",
			"/infra/railway/svc_acme_api?environmentId=env_acme_production",
		),
		scenario("gcp", "Google Cloud: Cloud Run", "/infra/gcp"),
		scenario("gcp-cloudsql", "Google Cloud: Cloud SQL tab", "/infra/gcp", {
			steps: press("Cloud SQL 1"),
		}),
		scenario("gcp-resources", "Google Cloud: Resources tab", "/infra/gcp", { steps: press("Resources") }),
		scenario("gcp-empty", "Google Cloud: not connected", "/infra/gcp", { dataset: EMPTY }),
		scenario(
			"gcp-workload",
			"Google Cloud: checkout-api",
			"/infra/gcp/cloudRun/checkout-api?project=acme-shop-prod&region=us-central1",
		),
		scenario(
			"gcp-cloudsql-instance",
			"Google Cloud: Cloud SQL orders-db",
			"/infra/gcp/cloudSql/acme-shop-prod%3Aorders-db?project=acme-shop-prod&region=us-central1",
		),
		scenario("planetscale", "PlanetScale: databases", "/infra/planetscale"),
		scenario("planetscale-sorted", "PlanetScale: sorted by storage", "/infra/planetscale", {
			steps: press("Storage"),
		}),
		scenario("planetscale-empty", "PlanetScale: not connected", "/infra/planetscale", { dataset: EMPTY }),
		scenario("planetscale-db", "PlanetScale database: acme-prod", "/infra/planetscale/acme-prod"),
	],
}
