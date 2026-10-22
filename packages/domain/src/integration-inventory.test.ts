import { describe, expect, it } from "vitest"
import {
	buildIntegrationInventory,
	type IntegrationInventoryInputs,
	withSourceHealth,
} from "./integration-inventory"

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

const zone = (
	zoneName: string,
	poll: { lastSuccessAt: number | null; lastErrorAt: number | null; lastError: string | null },
) => ({
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
					zone("ok.example", {
						lastSuccessAt: NOW - 2 * MINUTE,
						lastErrorAt: null,
						lastError: null,
					}),
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
		expect(railway?.resources[0]).toMatchObject({
			name: "shop / production",
			note: "no successful update for 2 h (3 services)",
		})
		expect(railway?.problem).toBe(
			"1 of 1 stale, e.g. environment shop / production: no successful update for 2 h (3 services)",
		)
	})

	it("lets a revoked grant outrank healthy resources", () => {
		const cloudflare = providerOf(
			{
				oauthConnections: [{ ...cloudflareGrant, revokedAt: NOW - MINUTE }],
				cloudflareStates: [
					zone("ok.example", { lastSuccessAt: NOW - MINUTE, lastErrorAt: null, lastError: null }),
				],
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
					detectedPermissions: { readDatabases: true, readMetricsEndpoints: false },
					lastInventoryAt: NOW - MINUTE,
					lastInventoryError: null,
					createdAt: NOW - 24 * 60 * MINUTE,
				},
			},
			"planetscale",
		)
		expect(planetscale?.status).toBe("failing")
		expect(planetscale?.problem).toContain("readMetricsEndpoints (database metrics)")
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

	it("never shows a scrape URL's userinfo or query, where tokens live", () => {
		const prometheus = providerOf(
			{
				scrapeTargets: [
					{
						name: "private",
						url: "https://user:s3cret@metrics.example/metrics?token=abc",
						serviceName: "billing",
						managedBy: null,
						scrapeIntervalSeconds: 15,
						lastScrapeAt: NOW - MINUTE,
						lastScrapeError: null,
					},
				],
			},
			"prometheus",
		)
		expect(prometheus?.resources[0]?.note).toBe("https://metrics.example/metrics → service billing")
	})

	it("drops the CI traces feed when no GitHub installation has CI traces on", () => {
		const github = providerOf(
			{
				vcsInstallations: [
					{
						provider: "github",
						accountLogin: "acme",
						status: "active",
						ciTracesEnabled: false,
						createdAt: NOW,
					},
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
		expect(github?.resources[0]).toMatchObject({
			lastError: "Not Found",
			note: "tracks main, PR review on",
		})
	})
})

describe("scrape targets", () => {
	it("lists a switched-off target as paused instead of dropping the provider", () => {
		const prometheus = providerOf(
			{
				scrapeTargets: [
					{
						name: "node",
						url: "http://node/metrics",
						serviceName: null,
						managedBy: null,
						scrapeIntervalSeconds: 15,
						lastScrapeAt: null,
						lastScrapeError: null,
						enabled: false,
					},
				],
			},
			"prometheus",
		)
		expect(prometheus?.status).toBe("paused")
		expect(prometheus?.resources.map((resource) => [resource.status, resource.note])).toEqual([
			["paused", "Scraping is turned off"],
		])
	})
})

describe("withSourceHealth", () => {
	const inventory = build({ oauthConnections: [cloudflareGrant] })

	it("reads a provider as the worst of its sources, with that source's problem", () => {
		const cloudflare = withSourceHealth(inventory, [
			{ platform: "cloudflare", health: { status: "healthy", lastDataAt: NOW, problem: null } },
			{
				platform: "cloudflare",
				health: { status: "failing", lastDataAt: NOW, problem: "Zone analytics need a permission" },
			},
			{ platform: "railway", health: { status: "disconnected", lastDataAt: null, problem: "Revoked" } },
		]).integrations.find((entry) => entry.provider === "cloudflare")
		expect(cloudflare).toMatchObject({ status: "failing", problem: "Zone analytics need a permission" })
	})

	it("never reads a provider better than its own resources", () => {
		const failingZone = build({
			oauthConnections: [cloudflareGrant],
			cloudflareStates: [
				zone("shop.example.com", { lastSuccessAt: null, lastErrorAt: NOW - MINUTE, lastError: "denied" }),
			],
		})
		const cloudflare = withSourceHealth(failingZone, [
			{ platform: "cloudflare", health: { status: "healthy", lastDataAt: NOW, problem: null } },
		]).integrations.find((entry) => entry.provider === "cloudflare")
		expect(cloudflare?.status).toBe("failing")
	})

	it("leaves a provider without sources as its resources say", () => {
		expect(withSourceHealth(inventory, [])).toEqual(inventory)
	})
})

