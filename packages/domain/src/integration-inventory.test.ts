import { describe, expect, it } from "vitest"
import { buildIntegrationInventory, type IntegrationInventoryInputs } from "./integration-inventory"

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
const MINUTE = 60_000

const empty: IntegrationInventoryInputs = {
	oauthConnections: [],
	vcsInstallations: [],
	vcsRepositories: [],
	cloudflareStates: [],
	cloudflareLogpush: [],
	cloudflareHyperdrives: [],
	railwayConnection: null,
	railwayEnvironments: [],
	planetscaleConnection: null,
	planetscaleDatabases: [],
	planetscalePollStates: [],
	scrapeTargets: [],
	chatWorkspaces: [],
}

const build = (inputs: Partial<IntegrationInventoryInputs>) =>
	buildIntegrationInventory({ ...empty, ...inputs }, NOW)

const providerOf = (inputs: Partial<IntegrationInventoryInputs>, provider: string) =>
	build(inputs).integrations.find((i) => i.provider === provider)

const cloudflareGrant = {
	provider: "cloudflare",
	externalAccountName: "Acme",
	externalUserEmail: null,
	revokedAt: null,
	createdAt: NOW - 30 * 24 * 60 * MINUTE,
}

const zone = (zoneName: string, poll: { lastSuccessAt: number | null; lastErrorAt: number | null; lastError: string | null }) => ({
	dataset: "http_requests",
	zoneName,
	...poll,
})

describe("buildIntegrationInventory", () => {
	it("lists every provider as available when nothing is connected", () => {
		const inventory = build({})
		expect(inventory.integrations).toEqual([])
		expect(inventory.available.map((a) => a.provider)).toEqual([
			"github",
			"cloudflare",
			"railway",
			"planetscale",
			"prometheus",
			"chat",
		])
	})

	it("marks a zone failing when its newest attempt errored, and names it in the provider problem", () => {
		const cloudflare = providerOf(
			{
				oauthConnections: [cloudflareGrant],
				cloudflareStates: [
					zone("ok.example", { lastSuccessAt: NOW - 2 * MINUTE, lastErrorAt: null, lastError: null }),
					zone("broken.example", {
						lastSuccessAt: NOW - 60 * MINUTE,
						lastErrorAt: NOW - 3 * MINUTE,
						lastError: "authentication error",
					}),
				],
			},
			"cloudflare",
		)
		expect(cloudflare?.status).toBe("failing")
		expect(cloudflare?.problem).toBe("1 of 2 failing, e.g. zone broken.example: authentication error")
		expect(cloudflare?.resources.map((r) => [r.name, r.status])).toEqual([
			["broken.example", "failing"],
			["ok.example", "healthy"],
		])
	})

	it("treats a success newer than the last error as recovered", () => {
		const cloudflare = providerOf(
			{
				oauthConnections: [cloudflareGrant],
				cloudflareStates: [
					zone("flaky.example", {
						lastSuccessAt: NOW - MINUTE,
						lastErrorAt: NOW - 10 * MINUTE,
						lastError: "timeout",
					}),
				],
			},
			"cloudflare",
		)
		expect(cloudflare?.status).toBe("healthy")
		expect(cloudflare?.problem).toBeNull()
		expect(cloudflare?.resources[0]?.lastError).toBeNull()
	})

	it("reports a poller that stopped succeeding as stale", () => {
		const railway = providerOf(
			{
				railwayConnection: {
					workspaceNames: "acme",
					authFailedAt: null,
					lastSuccessAt: NOW - MINUTE,
					lastErrorAt: null,
					lastError: null,
					createdAt: NOW - 24 * 60 * MINUTE,
				},
				railwayEnvironments: [
					{
						projectName: "shop",
						environmentName: "production",
						serviceCount: 3,
						lastSuccessAt: NOW - 2 * 60 * MINUTE,
						lastErrorAt: null,
						lastError: null,
					},
				],
			},
			"railway",
		)
		expect(railway?.status).toBe("stale")
		expect(railway?.resources[0]).toMatchObject({ name: "shop / production", note: "3 services" })
	})

	it("lets a revoked grant outrank healthy resources", () => {
		const cloudflare = providerOf(
			{
				oauthConnections: [{ ...cloudflareGrant, revokedAt: NOW - MINUTE }],
				cloudflareStates: [zone("ok.example", { lastSuccessAt: NOW - MINUTE, lastErrorAt: null, lastError: null })],
			},
			"cloudflare",
		)
		expect(cloudflare?.status).toBe("disconnected")
		expect(cloudflare?.problem).toContain("revoked")
	})

	it("reports a PlanetScale grant with no organization selected as pending", () => {
		const planetscale = providerOf(
			{ oauthConnections: [{ ...cloudflareGrant, provider: "planetscale" }] },
			"planetscale",
		)
		expect(planetscale?.status).toBe("pending")
		expect(planetscale?.problem).toContain("no PlanetScale organization is selected")
	})

	it("flags a PlanetScale grant missing a permission", () => {
		const planetscale = providerOf(
			{
				planetscaleConnection: {
					psOrganization: "acme",
					detectedPermissions: { read_databases: true, read_metrics_endpoints: false },
					lastInventoryAt: NOW - MINUTE,
					lastInventoryError: null,
					createdAt: NOW - 24 * 60 * MINUTE,
				},
			},
			"planetscale",
		)
		expect(planetscale?.status).toBe("failing")
		expect(planetscale?.problem).toContain("read_metrics_endpoints")
	})

	it("splits managed PlanetScale scrape targets from user Prometheus targets", () => {
		const target = {
			url: "https://metrics.example/metrics",
			serviceName: null,
			scrapeIntervalSeconds: 15,
			lastScrapeAt: NOW - MINUTE,
			lastScrapeError: null,
		}
		const inventory = build({
			planetscaleConnection: {
				psOrganization: "acme",
				detectedPermissions: null,
				lastInventoryAt: NOW - MINUTE,
				lastInventoryError: null,
				createdAt: NOW,
			},
			scrapeTargets: [
				{ ...target, name: "planetscale", managedBy: "planetscale:conn_1" },
				{ ...target, name: "node-exporter", managedBy: null, lastScrapeError: "connection refused" },
			],
		})
		const planetscale = inventory.integrations.find((i) => i.provider === "planetscale")
		const prometheus = inventory.integrations.find((i) => i.provider === "prometheus")
		expect(planetscale?.resources.map((r) => r.name)).toEqual(["planetscale"])
		expect(prometheus?.status).toBe("failing")
		expect(prometheus?.resources.map((r) => r.name)).toEqual(["node-exporter"])
	})

	it("drops the CI traces feed when no GitHub installation has CI traces on", () => {
		const github = providerOf(
			{
				vcsInstallations: [
					{ provider: "github", accountLogin: "acme", status: "active", ciTracesEnabled: false, createdAt: NOW },
				],
				vcsRepositories: [
					{
						provider: "github",
						fullName: "acme/api",
						syncStatus: "error",
						lastSyncedAt: null,
						lastSyncError: "Not Found",
						defaultBranch: "main",
						trackedBranch: null,
						prReviewEnabled: true,
					},
				],
			},
			"github",
		)
		expect(github?.feeds.some((feed) => feed.includes("GitHub Actions"))).toBe(false)
		expect(github?.status).toBe("failing")
		expect(github?.resources[0]).toMatchObject({ lastError: "Not Found", note: "tracks main, PR review on" })
	})
})
