import type { Locator, Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Infrastructure integrations on dataset `infra-integrations` (src/fixtures/areas/infra-integrations.ts):
 * Cloudflare zones, Workers and a queue, a Railway project, a Google Cloud project and two
 * PlanetScale databases, all with 24 h of poller metrics. Index pages also capture the `empty` org.
 */
const DATASET = "infra-integrations"
const RAILWAY_SERVICE = "/infra/railway/svc_acme_api?environmentId=env_acme_production"
const EMPTY = "empty"

const scenario = (
	id: string,
	title: string,
	path: string,
	options: {
		readonly dataset?: string
		readonly steps?: (page: Page) => Promise<void>
		readonly fullPage?: boolean
		readonly faults?: Scenario["faults"]
		readonly settle?: Scenario["settle"]
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
	faults: options.faults,
	settle: options.settle,
	area: "infra-integrations",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const held = (tag: string) => ({ faults: { delays: { [tag]: HELD_MS } }, settle: "held" as const })

const failing = (tag: string, status = 502, errorTag = "@maple/http/errors/QueryEngineExecutionError") => ({
	faults: {
		failures: {
			[tag]: { status, body: { _tag: errorTag, message: "ui-parity: injected failure" } },
		},
	},
})

/** Rests the pointer on an element long enough for a Base UI tooltip to open (600 ms delay). */
const hoverTooltip = (locate: (page: Page) => Locator, content: string) => async (page: Page) => {
	await locate(page).hover()
	await page.getByText(content).waitFor()
}

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
		scenario("railway-loading", "Railway: services loading", "/infra/railway", held("queryEngine.railwayInfraServices")),
		scenario("railway-status-loading", "Railway: status loading", "/infra/railway", held("integrations.railwayStatus")),
		scenario("railway-error", "Railway: services failing", "/infra/railway", failing("queryEngine.railwayInfraServices")),
		scenario("railway-sort-vcpu", "Railway: sorted by vCPU", "/infra/railway", { steps: press("vCPU") }),
		scenario("railway-sort-name-twice", "Railway: sorted by service, descending", "/infra/railway", {
			steps: async (page) => {
				await press("Service")(page)
				await press("Service")(page)
			},
		}),
		scenario("railway-search-cleared", "Railway: search typed, then cleared", "/infra/railway", {
			steps: async (page) => {
				await page.getByRole("textbox", { name: "Search services…" }).fill("zzz")
				await page.getByText("No services match these filters").waitFor()
				await page.getByRole("button", { name: "Clear search" }).click()
			},
		}),
		scenario("railway-memory-tooltip", "Railway: memory avg/peak tooltip", "/infra/railway", {
			steps: hoverTooltip(
				(page) => page.getByRole("link").filter({ hasText: "postgres" }).getByText("→").first(),
				"Over the selected time range.",
			),
		}),
		scenario("railway-connect-rejected", "Railway: connect with a rejected token", "/infra/railway", {
			dataset: EMPTY,
			...failing("integrations.railwayConnect", 400, "@maple/http/errors/IntegrationsValidationError"),
			steps: async (page) => {
				await page.getByRole("textbox", { name: "Account or workspace token" }).fill("rw_parity_token_0001")
				await page.getByRole("button", { name: "Connect Railway" }).click()
				await page.getByRole("alert").waitFor()
			},
		}),
		scenario(
			"railway-service",
			"Railway service: api (production)",
			"/infra/railway/svc_acme_api?environmentId=env_acme_production",
		),
		scenario(
			"railway-service-loading",
			"Railway service: metrics loading",
			RAILWAY_SERVICE,
			held("queryEngine.railwayInfraServiceTimeseries"),
		),
		scenario(
			"railway-service-error",
			"Railway service: metrics failing",
			RAILWAY_SERVICE,
			failing("queryEngine.railwayInfraServiceTimeseries"),
		),
		scenario("railway-service-hover", "Railway service: CPU chart hovered", RAILWAY_SERVICE, {
			steps: async (page) => {
				await page.getByRole("img", { name: "Utilization" }).first().hover({ position: { x: 300, y: 90 } })
				await page.getByText("Average").first().waitFor()
			},
		}),
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
		scenario(
			"planetscale-loading",
			"PlanetScale: inventory loading",
			"/infra/planetscale",
			held("planetscaleIntegration.databases"),
		),
		scenario(
			"planetscale-stats-loading",
			"PlanetScale: stats loading",
			"/infra/planetscale",
			held("queryEngine.servicePlanetScaleStats"),
		),
		scenario(
			"planetscale-stats-error",
			"PlanetScale: stats failing",
			"/infra/planetscale",
			failing("queryEngine.servicePlanetScaleStats"),
		),
		scenario("planetscale-sorted-name", "PlanetScale: sorted by database name", "/infra/planetscale", {
			steps: press("Database"),
		}),
		scenario("planetscale-db", "PlanetScale database: acme-prod", "/infra/planetscale/acme-prod"),
	],
}
