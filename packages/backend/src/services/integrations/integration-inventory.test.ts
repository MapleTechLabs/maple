import { describe, expect, it } from "vitest"
import { INTEGRATION_PROVIDERS, type IntegrationInventory } from "@maple/domain/integration-inventory"
import {
	buildIntegrationInventory,
	type IntegrationInventoryInputs,
	withSourceHealth,
} from "./integration-inventory"
import { AwsMetricStream } from "@maple/domain/aws"
import { Array as Arr, Option, Schema, String as Str } from "effect"

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
const MINUTE = 60_000

const empty: IntegrationInventoryInputs = {
	oauthConnections: [],
	vcsInstallations: [],
	vcsRepositories: [],
	cloudflareStates: [],
	cloudflareLogpush: [],
	cloudflareHyperdrives: [],
	gcpConnectors: [],
	gcpResourceCounts: [],
	awsConnections: [],
	supabaseConnection: null,
	supabaseProjects: [],
	railwayConnection: null,
	railwayEnvironments: [],
	vercelConnection: null,
	vercelProjectCount: 0,
	planetscaleConnection: null,
	planetscaleDatabases: [],
	planetscalePollStates: [],
	scrapeTargets: [],
	chatWorkspaces: [],
	searchConsoleSites: [],
}

const build = (inputs: Partial<IntegrationInventoryInputs>) =>
	buildIntegrationInventory({ ...empty, ...inputs }, NOW)

const findProvider = (inventory: IntegrationInventory, provider: string) =>
	Option.getOrUndefined(Arr.findFirst(inventory.integrations, (entry) => entry.provider === provider))

const providerOf = (inputs: Partial<IntegrationInventoryInputs>, provider: string) =>
	findProvider(build(inputs), provider)

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
		expect(Arr.map(inventory.available, (a) => a.provider)).toEqual([...INTEGRATION_PROVIDERS])
	})

	it("points a revoked Google grant at Integrations, where the Search Console card lives", () => {
		const revoked = { ...cloudflareGrant, provider: "google", revokedAt: NOW - MINUTE }
		expect(providerOf({ oauthConnections: [revoked] }, "search_console")).toMatchObject({
			status: "disconnected",
			problem: expect.stringContaining("reconnect it in Integrations"),
		})
	})

	it("reads a Google grant with no property selected as pending, and a failing import as failing", () => {
		const googleGrant = { ...cloudflareGrant, provider: "google", externalUserEmail: "owner@acme.dev" }
		expect(providerOf({ oauthConnections: [googleGrant] }, "search_console")).toMatchObject({
			status: "pending",
			account: "owner@acme.dev",
		})
		const failing = providerOf(
			{
				oauthConnections: [googleGrant],
				searchConsoleSites: [
					{
						siteUrl: "sc-domain:acme.dev",
						enabled: true,
						lastSyncedAt: NOW - MINUTE,
						lastError: null,
					},
					{
						siteUrl: "https://blog.acme.dev/",
						enabled: true,
						lastSyncedAt: null,
						lastError: "403",
					},
					{
						siteUrl: "https://old.acme.dev/",
						enabled: false,
						lastSyncedAt: null,
						lastError: "403",
					},
				],
			},
			"search_console",
		)
		expect(failing?.status).toBe("failing")
		expect(Arr.map(failing?.resources ?? [], (r) => r.name)).toEqual([
			"https://blog.acme.dev/",
			"sc-domain:acme.dev",
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
		expect(Arr.map(cloudflare?.resources ?? [], (r) => [r.name, r.status])).toEqual([
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

	describe("vercel", () => {
		const connection = {
			teamName: "Acme",
			authFailedAt: null,
			logsEnabled: true,
			tracesEnabled: true,
			aiGatewayEnabled: true,
			speedInsightsEnabled: false,
			webAnalyticsEnabled: false,
			auditLogEnabled: false,
			logDrainState: { status: "enabled", lastError: null },
			traceDrainState: { status: "enabled", lastError: null },
			aiGatewayDrainState: { status: "enabled", lastError: null },
			speedInsightsDrainState: null,
			webAnalyticsDrainState: null,
			auditLogDrainState: null,
			lastSuccessAt: NOW - MINUTE,
			lastErrorAt: null,
			lastError: null,
			createdAt: NOW - 24 * 60 * MINUTE,
		}

		it("is healthy with every drain enabled, and counts the team's projects", () => {
			const vercel = providerOf({ vercelConnection: connection, vercelProjectCount: 3 }, "vercel")
			expect(vercel?.status).toBe("healthy")
			expect(vercel?.account).toBe("Acme (3 projects)")
			expect(Arr.map(vercel?.resources ?? [], (r) => r.name)).toEqual(["AI Gateway", "logs", "traces"])
		})

		it("fails on a drain Vercel reports missing, and leaves out a drain that is turned off", () => {
			const vercel = providerOf(
				{
					vercelConnection: {
						...connection,
						tracesEnabled: false,
						aiGatewayEnabled: false,
						logDrainState: { status: "missing", lastError: "Drains need a Pro plan" },
					},
				},
				"vercel",
			)
			expect(vercel?.status).toBe("failing")
			expect(vercel?.resources).toHaveLength(1)
			expect(vercel?.problem).toBe("1 of 1 failing, e.g. drain logs: Drains need a Pro plan")
		})

		it("fails on an opt-in drain Vercel refused for the team's plan", () => {
			const vercel = providerOf(
				{
					vercelConnection: {
						...connection,
						auditLogEnabled: true,
						auditLogDrainState: {
							status: "errored",
							lastError: "Audit Log drains need Enterprise",
						},
					},
				},
				"vercel",
			)
			expect(vercel?.status).toBe("failing")
			expect(vercel?.problem).toBe(
				"1 of 4 failing, e.g. drain audit log: Audit Log drains need Enterprise",
			)
		})

		it("reports a rejected token as disconnected", () => {
			const vercel = providerOf(
				{ vercelConnection: { ...connection, authFailedAt: NOW - MINUTE } },
				"vercel",
			)
			expect(vercel?.status).toBe("disconnected")
			expect(vercel?.problem).toContain("Vercel rejected the access token")
		})
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

	it("flags a PlanetScale grant missing a permission, and ignores ones nothing uses anymore", () => {
		const withPermissions = (detectedPermissions: Record<string, boolean>) =>
			providerOf(
				{
					planetscaleConnection: {
						psOrganization: "acme",
						detectedPermissions,
						lastInventoryAt: NOW - MINUTE,
						lastInventoryError: null,
						createdAt: NOW - 24 * 60 * MINUTE,
					},
				},
				"planetscale",
			)
		const missing = withPermissions({ readDatabases: false })
		expect(missing?.status).toBe("failing")
		expect(missing?.problem).toContain("readDatabases (the database inventory and deploy requests)")
		// Bindings from before the metrics API stored this one; metrics no longer need it.
		expect(withPermissions({ readDatabases: true, readMetricsEndpoints: false })?.status).toBe("healthy")
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
		const planetscale = findProvider(inventory, "planetscale")
		const prometheus = findProvider(inventory, "prometheus")
		expect(Arr.map(planetscale?.resources ?? [], (r) => r.name)).toEqual(["planetscale"])
		expect(prometheus?.status).toBe("failing")
		expect(Arr.map(prometheus?.resources ?? [], (r) => r.name)).toEqual(["node-exporter"])
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
		expect(Arr.some(github?.feeds ?? [], (feed) => Str.includes("GitHub Actions")(feed))).toBe(false)
		expect(github?.status).toBe("failing")
		expect(github?.resources[0]).toMatchObject({
			lastError: "Not Found",
			note: "tracks main, PR review on",
		})
	})
})

describe("google cloud", () => {
	const connector = {
		id: "gcp_1",
		scopeType: "project",
		scopeId: "acme-prod",
		logsEnabled: true,
		metricsEnabled: true,
		lastReceivedAt: NOW - 5 * MINUTE,
		lastError: null,
		appliedLogsEnabled: true,
		appliedMetricsEnabled: true,
		setupReportedAt: NOW - 60 * MINUTE,
		lastMetricsReceivedAt: NOW - 5 * MINUTE,
		lastMetricsError: null,
		resourcesSyncedAt: NOW - 30 * MINUTE,
		lastResourcesError: null,
		createdAt: NOW - 24 * 60 * MINUTE,
	}

	it("lists logs, metrics and inventory per scope, counting projects apart from resources", () => {
		const gcp = providerOf(
			{
				gcpConnectors: [connector],
				gcpResourceCounts: [
					{
						connectorId: "gcp_1",
						assetType: "cloudresourcemanager.googleapis.com/Project",
						count: 1,
					},
					{ connectorId: "gcp_1", assetType: "run.googleapis.com/Service", count: 4 },
				],
			},
			"gcp",
		)
		expect(gcp?.status).toBe("healthy")
		expect(gcp?.account).toBe("project acme-prod")
		expect(Arr.map(gcp?.resources ?? [], (r) => r.kind).sort()).toEqual(["inventory", "logs", "metrics"])
		expect(
			Arr.findFirst(gcp?.resources ?? [], (r) => r.kind === "inventory").pipe(Option.getOrUndefined)
				?.note,
		).toBe("1 project, 4 resources")
	})

	it("fails on a metrics poll error and names it in the problem", () => {
		const gcp = providerOf(
			{
				gcpConnectors: [
					{ ...connector, lastMetricsError: "PERMISSION_DENIED: monitoring.timeSeries.list" },
				],
			},
			"gcp",
		)
		expect(gcp?.status).toBe("failing")
		expect(gcp?.problem).toContain("PERMISSION_DENIED")
	})

	it("is pending before the setup script has run, and leaves out what is switched off", () => {
		const gcp = providerOf(
			{
				gcpConnectors: [
					{
						...connector,
						metricsEnabled: false,
						lastReceivedAt: null,
						setupReportedAt: null,
						appliedLogsEnabled: null,
					},
				],
			},
			"gcp",
		)
		expect(gcp?.status).toBe("pending")
		expect(Arr.map(gcp?.resources ?? [], (r) => r.kind)).toEqual(["logs"])
	})
})

describe("aws", () => {
	const connection = {
		accountId: "123456789012",
		modules: ["observability"],
		grantedModules: ["observability"],
		templateVersion: 2,
		verifiedAt: NOW - 24 * 60 * MINUTE,
		lastCheckedAt: NOW - 30 * MINUTE,
		lastCheckError: null,
		metricStream: null,
		metricStreamChangedAt: null,
		streamLastReceivedAt: null,
		streamLastError: null,
		createdAt: NOW - 48 * 60 * MINUTE,
	} satisfies IntegrationInventoryInputs["awsConnections"][number]
	const stream = Schema.decodeSync(AwsMetricStream)({
		regions: ["us-east-1"],
		namespaces: ["AWS/Lambda"],
	})

	it("is healthy while the stream delivers", () => {
		const aws = providerOf(
			{
				awsConnections: [
					{ ...connection, metricStream: stream, streamLastReceivedAt: NOW - 2 * MINUTE },
				],
			},
			"aws",
		)
		expect(aws?.status).toBe("healthy")
		expect(aws?.account).toBe("123456789012")
	})

	it("fails on a stream that never delivered long after the setup", () => {
		const aws = providerOf(
			{
				awsConnections: [
					{ ...connection, metricStream: stream, metricStreamChangedAt: NOW - 120 * MINUTE },
				],
			},
			"aws",
		)
		expect(aws?.status).toBe("failing")
		expect(aws?.problem).toContain("No metrics have arrived")
	})

	it("reads an account with no metric stream as paused, and one not yet deployed as pending", () => {
		expect(providerOf({ awsConnections: [connection] }, "aws")?.status).toBe("paused")
		const undeployed = providerOf(
			{ awsConnections: [{ ...connection, verifiedAt: null, grantedModules: null }] },
			"aws",
		)
		expect(undeployed?.status).toBe("pending")
	})

	it("fails when the role can no longer be assumed", () => {
		const aws = providerOf(
			{ awsConnections: [{ ...connection, lastCheckError: "Maple can no longer assume the role" }] },
			"aws",
		)
		expect(aws?.status).toBe("failing")
		expect(aws?.problem).toContain("can no longer assume the role")
	})
})

describe("supabase", () => {
	const supabaseGrant = {
		provider: "supabase",
		externalAccountName: null,
		externalUserEmail: null,
		revokedAt: null,
		createdAt: NOW - 24 * 60 * MINUTE,
	}
	const connection = {
		organizationName: "Acme",
		lastDiscoveryAt: NOW - 10 * MINUTE,
		lastDiscoveryError: null,
		createdAt: NOW - 24 * 60 * MINUTE,
	}
	const project = {
		name: "shop",
		region: "eu-central-1",
		status: "ACTIVE_HEALTHY",
		logDrainEnabled: false,
		logDrainError: null,
		logsEnabled: false,
		logsLastPolledAt: null,
		logsError: null,
	}

	it("is healthy with a healthy project and its metrics scrape", () => {
		const supabase = providerOf(
			{
				oauthConnections: [supabaseGrant],
				supabaseConnection: connection,
				supabaseProjects: [project],
				scrapeTargets: [
					{
						name: "Supabase shop",
						url: "https://abcdefghijklmnopqrst.supabase.co/customer/v1/privileged/metrics",
						serviceName: null,
						managedBy: "supabase:conn_1",
						scrapeIntervalSeconds: 60,
						lastScrapeAt: NOW - MINUTE,
						lastScrapeError: null,
					},
				],
			},
			"supabase",
		)
		expect(supabase?.status).toBe("healthy")
		expect(supabase?.account).toBe("Acme")
		expect(Arr.map(supabase?.resources ?? [], (r) => r.kind).sort()).toEqual([
			"metrics scrape",
			"project",
		])
	})

	it("keeps Supabase's managed scrape targets out of Prometheus", () => {
		const inventory = build({
			oauthConnections: [supabaseGrant],
			supabaseConnection: connection,
			scrapeTargets: [
				{
					name: "Supabase shop",
					url: "https://abcdefghijklmnopqrst.supabase.co/metrics",
					serviceName: null,
					managedBy: "supabase:conn_1",
					scrapeIntervalSeconds: 60,
					lastScrapeAt: NOW - MINUTE,
					lastScrapeError: null,
				},
			],
		})
		expect(findProvider(inventory, "prometheus")).toBeUndefined()
	})

	it("fails on a log drain error and reads a paused project as paused", () => {
		const supabase = providerOf(
			{
				oauthConnections: [supabaseGrant],
				supabaseConnection: connection,
				supabaseProjects: [
					{ ...project, logDrainEnabled: true, logDrainError: "drain rejected: 403" },
					{ ...project, name: "old", status: "INACTIVE" },
				],
			},
			"supabase",
		)
		expect(supabase?.status).toBe("failing")
		expect(supabase?.problem).toContain("drain rejected: 403")
		expect(Arr.map(supabase?.resources ?? [], (r) => `${r.name}:${r.status}`)).toEqual([
			"shop:failing",
			"old:paused",
		])
	})

	it("reads a running project whose log polling stopped as stale, but not a paused one", () => {
		const stopped = { ...project, logsEnabled: true, logsLastPolledAt: NOW - 3 * 60 * MINUTE }
		const supabase = providerOf(
			{
				oauthConnections: [supabaseGrant],
				supabaseConnection: connection,
				supabaseProjects: [
					stopped,
					{ ...stopped, name: "old", status: "INACTIVE" },
					{ ...project, name: "live", logsEnabled: true, logsLastPolledAt: NOW - MINUTE },
				],
			},
			"supabase",
		)
		expect(Arr.map(supabase?.resources ?? [], (r) => `${r.name}:${r.status}`)).toEqual([
			"shop:stale",
			"old:paused",
			"live:healthy",
		])
	})

	it("reports a revoked grant as disconnected, and a discovery error as failing", () => {
		expect(
			providerOf(
				{
					oauthConnections: [{ ...supabaseGrant, revokedAt: NOW - MINUTE }],
					supabaseConnection: connection,
				},
				"supabase",
			)?.status,
		).toBe("disconnected")
		const failing = providerOf(
			{
				oauthConnections: [supabaseGrant],
				supabaseConnection: { ...connection, lastDiscoveryError: "Supabase answered 500" },
			},
			"supabase",
		)
		expect(failing?.status).toBe("failing")
		expect(failing?.problem).toBe("Project discovery failing: Supabase answered 500")
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
		expect(Arr.map(prometheus?.resources ?? [], (resource) => [resource.status, resource.note])).toEqual([
			["paused", "Scraping is turned off"],
		])
	})
})

describe("withSourceHealth", () => {
	const inventory = build({ oauthConnections: [cloudflareGrant] })

	it("reads a provider as the worst of its sources, with that source's problem", () => {
		const cloudflare = findProvider(
			withSourceHealth(inventory, [
				{ platform: "cloudflare", health: { status: "healthy", lastDataAt: NOW, problem: null } },
				{
					platform: "cloudflare",
					health: {
						status: "failing",
						lastDataAt: NOW,
						problem: "Zone analytics need a permission",
					},
				},
				{
					platform: "railway",
					health: { status: "disconnected", lastDataAt: null, problem: "Revoked" },
				},
			]),
			"cloudflare",
		)
		expect(cloudflare).toMatchObject({ status: "failing", problem: "Zone analytics need a permission" })
	})

	it("never reads a provider better than its own resources", () => {
		const failingZone = build({
			oauthConnections: [cloudflareGrant],
			cloudflareStates: [
				zone("shop.example.com", {
					lastSuccessAt: null,
					lastErrorAt: NOW - MINUTE,
					lastError: "denied",
				}),
			],
		})
		const cloudflare = findProvider(
			withSourceHealth(failingZone, [
				{ platform: "cloudflare", health: { status: "healthy", lastDataAt: NOW, problem: null } },
			]),
			"cloudflare",
		)
		expect(cloudflare?.status).toBe("failing")
	})

	it("leaves a provider without sources as its resources say", () => {
		expect(withSourceHealth(inventory, [])).toEqual(inventory)
	})
})
