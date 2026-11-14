// What each connected integration is, what it feeds, and whether it is working. Pure: one IO pass
// fills `IntegrationInventoryInputs` (narrow column projections, epoch ms), then
// `buildIntegrationInventory` derives every status, same shape as `../org/setup-audit`.

import {
	INTEGRATION_PROVIDERS,
	type IntegrationEntry,
	type IntegrationInventory,
	type IntegrationProvider,
	type IntegrationResource,
	type IntegrationStatus,
} from "@maple/domain/integration-inventory"
import {
	AWS_METRICS_OFF,
	AWS_NO_DELIVERY,
	AWS_TEMPLATE_VERSION,
	type AwsMetricStream,
	awsStreamState,
} from "@maple/domain/aws"
import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
import { type SourceHealthResult, worstSourceStatus } from "@maple/domain/source-health"
import { redactUrlSecrets } from "@maple/domain/url-redaction"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"

const STATUS_RANK = {
	disconnected: 0,
	failing: 1,
	stale: 2,
	paused: 3,
	pending: 4,
	healthy: 5,
} satisfies Record<IntegrationStatus, number>

export const worstStatus = worstSourceStatus

/** The alerting pollers tick every 5 minutes; six missed ticks is no longer a blip. */
const POLLER_STALE_MS = 30 * 60 * 1000
/** PlanetScale inventory refreshes hourly and deploy requests round-robin 25 databases per tick. */
const PLANETSCALE_STALE_MS = 3 * 60 * 60 * 1000
/** Search Console re-imports its head every few hours; two days without a success is no longer a blip. */
const SEARCH_CONSOLE_STALE_MS = 2 * 24 * 60 * 60 * 1000
const SCRAPE_MIN_STALE_MS = 10 * 60 * 1000
/** Google Cloud's resource inventory syncs hourly; three missed syncs is no longer a blip. */
const GCP_INVENTORY_STALE_MS = 3 * 60 * 60 * 1000
/** GCP reads every 5 minutes; an error with no read for three ticks is a failed read, not a partial one. */
const GCP_METRICS_FAILED_AFTER_MS = 15 * 60 * 1000
/** Resources sync hourly; an error with no sync for 70 minutes is a failed sync, not a truncated one. */
const GCP_RESOURCES_FAILED_AFTER_MS = 70 * 60 * 1000

/** How long a scrape target may go without a good scrape: ten intervals, at least 10 minutes. */
export const scrapeStaleAfterMs = (scrapeIntervalSeconds: number) =>
	Math.max(SCRAPE_MIN_STALE_MS, scrapeIntervalSeconds * 10 * 1000)

export interface PollState {
	readonly lastSuccessAt: number | null
	readonly lastErrorAt: number | null
	readonly lastError: string | null
}

export interface IntegrationInventoryInputs {
	readonly oauthConnections: ReadonlyArray<{
		readonly provider: string
		readonly externalAccountName: string | null
		readonly externalUserEmail: string | null
		readonly revokedAt: number | null
		readonly createdAt: number
	}>
	readonly vcsInstallations: ReadonlyArray<{
		readonly provider: string
		readonly accountLogin: string
		readonly status: string
		readonly ciTracesEnabled: boolean
		readonly createdAt: number
	}>
	readonly vcsRepositories: ReadonlyArray<{
		readonly provider: string
		readonly fullName: string
		readonly syncStatus: string
		readonly lastSyncedAt: number | null
		readonly lastSyncError: string | null
		readonly defaultBranch: string
		readonly trackedBranch: string | null
		readonly prReviewEnabled: boolean
	}>
	readonly cloudflareStates: ReadonlyArray<
		PollState & { readonly dataset: string; readonly zoneName: string | null }
	>
	readonly cloudflareLogpush: ReadonlyArray<{
		readonly name: string
		readonly zoneName: string
		readonly serviceName: string
		readonly lastReceivedAt: number | null
		readonly lastError: string | null
	}>
	readonly cloudflareHyperdrives: ReadonlyArray<{
		readonly name: string
		readonly originScheme: string
		readonly originHost: string | null
		readonly originDatabase: string
	}>
	readonly railwayConnection:
		| (PollState & {
				readonly workspaceNames: string | null
				readonly authFailedAt: number | null
				readonly createdAt: number
		  })
		| null
	readonly railwayEnvironments: ReadonlyArray<
		PollState & {
			readonly projectName: string
			readonly environmentName: string
			readonly serviceCount: number
		}
	>
	readonly vercelConnection:
		| (PollState & {
				readonly teamName: string
				readonly authFailedAt: number | null
				readonly logsEnabled: boolean
				readonly tracesEnabled: boolean
				readonly aiGatewayEnabled: boolean
				readonly speedInsightsEnabled: boolean
				readonly webAnalyticsEnabled: boolean
				readonly auditLogEnabled: boolean
				readonly logDrainState: VercelDrainSnapshot | null
				readonly traceDrainState: VercelDrainSnapshot | null
				readonly aiGatewayDrainState: VercelDrainSnapshot | null
				readonly speedInsightsDrainState: VercelDrainSnapshot | null
				readonly webAnalyticsDrainState: VercelDrainSnapshot | null
				readonly auditLogDrainState: VercelDrainSnapshot | null
				readonly createdAt: number
		  })
		| null
	readonly vercelProjectCount: number
	readonly planetscaleConnection: {
		readonly psOrganization: string
		readonly detectedPermissions: Readonly<Record<string, boolean>> | null
		readonly lastInventoryAt: number | null
		readonly lastInventoryError: string | null
		readonly createdAt: number
	} | null
	readonly planetscaleDatabases: ReadonlyArray<{
		readonly databaseId: string
		readonly name: string
		readonly kind: string
		readonly region: string | null
		readonly state: string | null
	}>
	readonly planetscalePollStates: ReadonlyArray<PollState & { readonly databaseId: string }>
	readonly scrapeTargets: ReadonlyArray<{
		readonly name: string
		readonly url: string
		readonly serviceName: string | null
		readonly managedBy: string | null
		readonly scrapeIntervalSeconds: number
		readonly lastScrapeAt: number | null
		readonly lastScrapeError: string | null
		/** False for a target switched off; absent reads as on. */
		readonly enabled?: boolean
	}>
	readonly chatWorkspaces: ReadonlyArray<{
		readonly connector: string
		readonly name: string
		readonly createdAt: number
	}>
	readonly gcpConnectors: ReadonlyArray<{
		readonly id: string
		readonly scopeType: string
		readonly scopeId: string
		readonly logsEnabled: boolean
		readonly metricsEnabled: boolean
		readonly lastReceivedAt: number | null
		readonly lastError: string | null
		readonly appliedLogsEnabled: boolean | null
		readonly appliedMetricsEnabled: boolean | null
		readonly setupReportedAt: number | null
		readonly lastMetricsReceivedAt: number | null
		readonly lastMetricsError: string | null
		readonly resourcesSyncedAt: number | null
		readonly lastResourcesError: string | null
		readonly createdAt: number
	}>
	/** `gcp_resources` rows per connector and asset type. */
	readonly gcpResourceCounts: ReadonlyArray<{
		readonly connectorId: string
		readonly assetType: string
		readonly count: number
	}>
	readonly awsConnections: ReadonlyArray<{
		readonly accountId: string
		readonly modules: ReadonlyArray<string>
		readonly grantedModules: ReadonlyArray<string> | null
		readonly templateVersion: number | null
		readonly verifiedAt: number | null
		readonly lastCheckedAt: number | null
		readonly lastCheckError: string | null
		readonly metricStream: AwsMetricStream | null
		readonly metricStreamChangedAt: number | null
		readonly streamLastReceivedAt: number | null
		readonly streamLastError: string | null
		readonly createdAt: number
	}>
	/** Its grant is the `oauthConnections` row with provider "supabase". */
	readonly supabaseConnection: {
		readonly organizationName: string
		readonly lastDiscoveryAt: number | null
		readonly lastDiscoveryError: string | null
		readonly createdAt: number
	} | null
	/** The connection's projects that discovery still lists. */
	readonly supabaseProjects: ReadonlyArray<{
		readonly name: string
		readonly region: string
		readonly status: string
		readonly logDrainEnabled: boolean
		readonly logDrainError: string | null
		readonly logsEnabled: boolean
		readonly logsLastPolledAt: number | null
		readonly logsError: string | null
	}>
	/** Search Console properties under the org's Google grant (`oauthConnections` provider "google"). */
	readonly searchConsoleSites: ReadonlyArray<{
		readonly siteUrl: string
		readonly enabled: boolean
		readonly lastSyncedAt: number | null
		readonly lastError: string | null
	}>
}

/** What the poller last saw of one Vercel drain. */
export interface VercelDrainSnapshot {
	readonly status: string
	readonly lastError: string | null
}

export const INTEGRATION_FEEDS = {
	github: [
		"source code for Maple's investigations and pull request review",
		"commit metadata for deploys (service_deployments)",
		"GitHub Actions runs as traces under service.name=github-actions, with job logs as logs on their step spans",
	],
	cloudflare: [
		"zone HTTP traffic and Worker invocations as metrics",
		"Logpush HTTP request logs",
		"Hyperdrive origins resolved on the service map",
	],
	gcp: [
		"Cloud Logging logs through a Pub/Sub push subscription",
		"Cloud Monitoring metrics and the Cloud Asset Inventory of the connected scope",
	],
	aws: ["CloudWatch metrics through a metric stream, for the regions and namespaces picked"],
	railway: ["per-service CPU, memory, network and disk metrics"],
	vercel: [
		"function, edge, build and request logs through a log drain",
		"deployment and AI Gateway traces through a trace drain",
		"project and deployment inventory (list_infra kind=vercel_projects)",
	],
	planetscale: [
		"database metrics through a managed Prometheus scrape",
		"query insights and deploy-request events",
	],
	supabase: [
		"project database and API metrics through a managed Prometheus scrape",
		"project logs through a log drain or polled logs",
		"advisor findings and the slowest statements per project",
	],
	prometheus: ["metrics scraped from Prometheus endpoints (list_metrics)"],
	chat: ["the Maple bot in chat workspaces", "alert issues and comments in Linear"],
	search_console: [
		"Google search queries, pages, clicks and positions for the selected properties (daily import)",
	],
} satisfies Record<IntegrationProvider, ReadonlyArray<string>>

/** The newest attempt decides: an error newer than the last success is failing. */
export const pollStatus = (state: PollState, now: number, staleAfterMs: number): IntegrationStatus => {
	if (
		state.lastErrorAt !== null &&
		(state.lastSuccessAt === null || state.lastErrorAt > state.lastSuccessAt)
	) {
		return "failing"
	}
	if (state.lastSuccessAt === null) return "pending"
	return now - state.lastSuccessAt > staleAfterMs ? "stale" : "healthy"
}

const failingError = (state: PollState, status: IntegrationStatus) =>
	status === "failing" ? state.lastError : null

/** "2 of 14 zones failing: <first error>", or null when every resource is healthy. */
export const summarizeResources = (resources: ReadonlyArray<IntegrationResource>): string | null => {
	const unhealthy = Arr.filter(resources, (r) => r.status !== "healthy")
	if (unhealthy.length === 0) return null
	const worst = worstStatus(Arr.map(unhealthy, (r) => r.status))
	const ofWorst = Arr.filter(unhealthy, (r) => r.status === worst)
	const example = Option.getOrUndefined(Arr.findFirst(ofWorst, (r) => r.lastError !== null)) ?? ofWorst[0]
	if (example === undefined) return null
	const detail = example.lastError ?? example.note
	return `${ofWorst.length} of ${resources.length} ${worst}, e.g. ${example.kind} ${example.name}${detail ? `: ${detail}` : ""}`
}

/** "4 h", "25 min", "3 days": how long a resource has gone without a successful update. */
export const formatAge = (ms: number): string => {
	const minutes = Math.round(ms / 60_000)
	if (minutes < 90) return `${minutes} min`
	const hours = Math.round(minutes / 60)
	return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

/** A stale resource says how old its data is; that is the whole finding. */
const withAge = (resource: IntegrationResource, now: number): IntegrationResource =>
	resource.status === "stale" && resource.lastSuccessAt !== null
		? {
				...resource,
				note: `no successful update for ${formatAge(now - resource.lastSuccessAt)}${resource.note ? ` (${resource.note})` : ""}`,
			}
		: resource

const entry = (
	provider: IntegrationProvider,
	now: number,
	fields: {
		readonly account: string | null
		readonly connectedAt: number | null
		/** A provider-wide condition (revoked grant, auth failure) that outranks its resources. */
		readonly own?: { readonly status: IntegrationStatus; readonly problem: string } | undefined
		readonly resources: ReadonlyArray<IntegrationResource>
		readonly feeds?: ReadonlyArray<string>
	},
): IntegrationEntry => {
	// Sorted before summarizing, so `summarizeResources(entry.resources)` reproduces the summary.
	const resources = Arr.map(fields.resources, (r) => withAge(r, now)).sort((a, b) =>
		STATUS_RANK[a.status] !== STATUS_RANK[b.status]
			? STATUS_RANK[a.status] - STATUS_RANK[b.status]
			: Str.localeCompare(b.name)(a.name),
	)
	const resourceStatus = worstStatus(Arr.map(resources, (r) => r.status))
	const status = worstStatus([fields.own?.status ?? "healthy", resourceStatus])
	const problem =
		fields.own && STATUS_RANK[fields.own.status] <= STATUS_RANK[resourceStatus]
			? fields.own.problem
			: summarizeResources(resources)
	return {
		provider,
		status,
		account: fields.account,
		connectedAt: fields.connectedAt,
		problem: status === "healthy" ? null : problem,
		feeds: fields.feeds ?? INTEGRATION_FEEDS[provider],
		resources,
	}
}

const oauthFor = (inputs: IntegrationInventoryInputs, provider: string) =>
	Option.getOrUndefined(Arr.findFirst(inputs.oauthConnections, (c) => c.provider === provider))

const isRevoked = (oauth: IntegrationInventoryInputs["oauthConnections"][number] | undefined) =>
	oauth !== undefined && oauth.revokedAt !== null

const revokedProblem = (label: string) => ({
	status: "disconnected" as const,
	problem: `${label} revoked Maple's access; reconnect it in Sources.`,
})

const github = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const installations = Arr.filter(inputs.vcsInstallations, (i) => i.provider === "github")
	if (installations.length === 0) return null
	const active = Arr.filter(installations, (i) => i.status === "active")
	const resources = Arr.map(
		Arr.filter(inputs.vcsRepositories, (r) => r.provider === "github"),
		(repo): IntegrationResource => {
			const status: IntegrationStatus =
				repo.syncStatus === "error" ? "failing" : repo.syncStatus === "ready" ? "healthy" : "pending"
			const branch = repo.trackedBranch ?? repo.defaultBranch
			return {
				kind: "repository",
				name: repo.fullName,
				status,
				lastSuccessAt: repo.lastSyncedAt,
				lastError: status === "failing" ? repo.lastSyncError : null,
				note: `tracks ${branch}${repo.prReviewEnabled ? ", PR review on" : ""}${status === "pending" ? `, sync ${repo.syncStatus}` : ""}`,
			}
		},
	)
	const ciTraces = Arr.some(active, (i) => i.ciTracesEnabled)
	return entry("github", now, {
		account: Arr.join(
			Arr.map(installations, (i) => i.accountLogin),
			", ",
		),
		connectedAt: Math.min(...Arr.map(installations, (i) => i.createdAt)),
		own:
			active.length === 0
				? {
						status: "disconnected",
						problem: `The GitHub App installation is ${Arr.join(
							Arr.map(installations, (i) => i.status),
							", ",
						)}; reinstall it in Sources.`,
					}
				: undefined,
		resources,
		feeds: Arr.filter(
			INTEGRATION_FEEDS.github,
			(feed) => ciTraces || !Str.startsWith("GitHub Actions")(feed),
		),
	})
}

const cloudflare = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const oauth = oauthFor(inputs, "cloudflare")
	if (!oauth && inputs.cloudflareStates.length === 0 && inputs.cloudflareLogpush.length === 0) return null
	const analytics = Arr.map(inputs.cloudflareStates, (state): IntegrationResource => {
		const status = pollStatus(state, now, POLLER_STALE_MS)
		const isZone = state.dataset === "http_requests"
		return {
			kind: isZone ? "zone" : state.dataset === "workers_invocations" ? "workers" : state.dataset,
			name: isZone ? (state.zoneName ?? "(unnamed zone)") : (state.zoneName ?? "account"),
			status,
			lastSuccessAt: state.lastSuccessAt,
			lastError: failingError(state, status),
			note: null,
		}
	})
	const logpush = Arr.map(inputs.cloudflareLogpush, (connector): IntegrationResource => ({
		kind: "logpush",
		name: connector.name,
		status:
			connector.lastError !== null
				? "failing"
				: connector.lastReceivedAt === null
					? "pending"
					: "healthy",
		lastSuccessAt: connector.lastReceivedAt,
		lastError: connector.lastError,
		note: `${connector.zoneName} → service ${connector.serviceName}`,
	}))
	const hyperdrives = Arr.map(inputs.cloudflareHyperdrives, (config): IntegrationResource => ({
		kind: "hyperdrive",
		name: config.name,
		status: "healthy",
		lastSuccessAt: null,
		lastError: null,
		note: `${config.originScheme}://${config.originHost ?? "(private origin)"}/${config.originDatabase}`,
	}))
	return entry("cloudflare", now, {
		account: oauth?.externalAccountName ?? oauth?.externalUserEmail ?? null,
		connectedAt: oauth?.createdAt ?? null,
		own: isRevoked(oauth) ? revokedProblem("Cloudflare") : undefined,
		resources: [...analytics, ...logpush, ...hyperdrives],
	})
}

const railway = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const connection = inputs.railwayConnection
	if (connection === null) return null
	const resources = Arr.map(inputs.railwayEnvironments, (env): IntegrationResource => {
		const status = pollStatus(env, now, POLLER_STALE_MS)
		return {
			kind: "environment",
			name: `${env.projectName} / ${env.environmentName}`,
			status,
			lastSuccessAt: env.lastSuccessAt,
			lastError: failingError(env, status),
			note: `${env.serviceCount} service${env.serviceCount === 1 ? "" : "s"}`,
		}
	})
	const connectionStatus = pollStatus(connection, now, POLLER_STALE_MS)
	const own =
		connection.authFailedAt !== null
			? {
					status: "disconnected" as const,
					problem: "Railway rejected the API token; save a new one in Sources.",
				}
			: connectionStatus === "failing"
				? {
						status: "failing" as const,
						problem: `Discovery failing: ${connection.lastError ?? "unknown error"}`,
					}
				: undefined
	return entry("railway", now, {
		account: connection.workspaceNames,
		connectedAt: connection.createdAt,
		own,
		resources,
	})
}

export const PLANETSCALE_NO_ORGANIZATION_PROBLEM =
	"Authorized, but no PlanetScale organization is selected yet; pick one in Sources."

const vercel = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const connection = inputs.vercelConnection
	if (connection === null) return null
	const drain = (
		name: string,
		enabled: boolean,
		state: VercelDrainSnapshot | null,
	): ReadonlyArray<IntegrationResource> => {
		if (!enabled) return []
		// "unknown": Vercel's answer carried no status; the next check reads it.
		const unchecked = state === null || state.status === "unknown"
		const status: IntegrationStatus = unchecked
			? "pending"
			: state.status === "enabled"
				? "healthy"
				: "failing"
		return [
			{
				kind: "drain",
				name,
				status,
				lastSuccessAt: null,
				lastError: status === "failing" ? (state?.lastError ?? `drain ${state?.status}`) : null,
				note: unchecked ? "not checked yet" : null,
			},
		]
	}
	const connectionStatus = pollStatus(connection, now, POLLER_STALE_MS)
	const own =
		connection.authFailedAt !== null
			? {
					status: "disconnected" as const,
					problem: "Vercel rejected the access token; save a new one in Settings → Integrations.",
				}
			: connectionStatus === "failing" || connectionStatus === "stale"
				? {
						status: connectionStatus,
						problem:
							connectionStatus === "failing"
								? `Sync failing: ${connection.lastError ?? "unknown error"}`
								: "The project and drain check has not succeeded recently.",
					}
				: undefined
	return entry("vercel", now, {
		account: `${connection.teamName} (${inputs.vercelProjectCount} project${inputs.vercelProjectCount === 1 ? "" : "s"})`,
		connectedAt: connection.createdAt,
		own,
		resources: [
			...drain("logs", connection.logsEnabled, connection.logDrainState),
			...drain("traces", connection.tracesEnabled, connection.traceDrainState),
			...drain("AI Gateway", connection.aiGatewayEnabled, connection.aiGatewayDrainState),
			...drain("Speed Insights", connection.speedInsightsEnabled, connection.speedInsightsDrainState),
			...drain("Web Analytics", connection.webAnalyticsEnabled, connection.webAnalyticsDrainState),
			...drain("audit log", connection.auditLogEnabled, connection.auditLogDrainState),
		],
	})
}

const planetscale = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const oauth = oauthFor(inputs, "planetscale")
	const connection = inputs.planetscaleConnection
	if (!oauth && connection === null) return null
	if (connection === null) {
		return entry("planetscale", now, {
			account: oauth?.externalAccountName ?? oauth?.externalUserEmail ?? null,
			connectedAt: oauth?.createdAt ?? null,
			own: isRevoked(oauth)
				? revokedProblem("PlanetScale")
				: {
						status: "pending",
						problem: PLANETSCALE_NO_ORGANIZATION_PROBLEM,
					},
			resources: [],
		})
	}
	const databases = Arr.map(inputs.planetscaleDatabases, (db): IntegrationResource => {
		const states = Arr.filter(inputs.planetscalePollStates, (s) => s.databaseId === db.databaseId)
		const statuses = Arr.map(states, (s) => pollStatus(s, now, PLANETSCALE_STALE_MS))
		const status = states.length === 0 ? "healthy" : worstStatus(statuses)
		const failing = Option.getOrUndefined(Arr.findFirst(states, (_, i) => statuses[i] === "failing"))
		return {
			kind: "database",
			name: db.name,
			status,
			lastSuccessAt: Arr.reduce<(typeof states)[number], number | null>(states, null, (latest, s) =>
				s.lastSuccessAt !== null && (latest === null || s.lastSuccessAt > latest)
					? s.lastSuccessAt
					: latest,
			),
			lastError: failing?.lastError ?? null,
			note: Arr.join(
				Arr.filter(
					[db.kind, db.region, db.state],
					(part): part is string => part !== null && part !== "",
				),
				", ",
			),
		}
	})
	// A disabled managed target only holds branch filters: metrics come from the metrics API.
	const scrape = Arr.map(
		Arr.filter(
			inputs.scrapeTargets,
			(t) => t.managedBy != null && Str.startsWith("planetscale:")(t.managedBy) && t.enabled !== false,
		),
		(t) => scrapeResource(t, now, "metrics scrape"),
	)
	// Only permissions something still depends on; older bindings stored ones that no longer matter.
	const missing = Arr.map(
		Arr.filter(
			Rec.toEntries(connection.detectedPermissions ?? {}),
			([permission, granted]) =>
				!granted && Arr.some(PLANETSCALE_PERMISSION_FEEDS, ([key]) => key === permission),
		),
		([permission]) => permission,
	)
	// The inventory pass clears its error on success, so a set error is the latest outcome.
	const own = isRevoked(oauth)
		? revokedProblem("PlanetScale")
		: connection.lastInventoryError !== null
			? { status: "failing" as const, problem: `Inventory failing: ${connection.lastInventoryError}` }
			: missing.length > 0
				? {
						status: "failing" as const,
						problem: `The grant lacks ${Arr.join(
							Arr.map(missing, (permission) => `${permission} (${permissionFeed(permission)})`),
							", ",
						)}; reconnect PlanetScale in Sources with it granted.`,
					}
				: connection.lastInventoryAt === null
					? { status: "pending" as const, problem: "The first database inventory has not run yet." }
					: undefined
	return entry("planetscale", now, {
		account: connection.psOrganization,
		connectedAt: connection.createdAt,
		own,
		resources: [...databases, ...scrape],
	})
}

/** What each permission probed at org-binding time feeds, so a missing one names its effect. */
const PLANETSCALE_PERMISSION_FEEDS = [
	["readDatabases", "the database inventory and deploy requests"],
	["readOrganization", "the organization lookup"],
] as const

const permissionFeed = (permission: string) =>
	Option.match(
		Arr.findFirst(PLANETSCALE_PERMISSION_FEEDS, ([key]) => key === permission),
		{ onNone: () => "unknown use", onSome: ([, feed]) => feed },
	)

export const scrapeResource = (
	target: IntegrationInventoryInputs["scrapeTargets"][number],
	now: number,
	kind: string,
): IntegrationResource => {
	const staleAfterMs = scrapeStaleAfterMs(target.scrapeIntervalSeconds)
	// A failed scrape leaves lastScrapeAt at the last success and sets the error; a later success clears it.
	const status: IntegrationStatus =
		target.enabled === false
			? "paused"
			: target.lastScrapeError !== null
				? "failing"
				: target.lastScrapeAt === null
					? "pending"
					: now - target.lastScrapeAt > staleAfterMs
						? "stale"
						: "healthy"
	return {
		kind,
		name: target.name,
		status,
		lastSuccessAt: target.lastScrapeAt,
		lastError: target.lastScrapeError,
		note:
			target.enabled === false
				? "Scraping is turned off"
				: target.serviceName
					? `${redactUrlSecrets(target.url)} → service ${target.serviceName}`
					: redactUrlSecrets(target.url),
	}
}

const gcp = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const connectors = inputs.gcpConnectors
	if (connectors.length === 0) return null
	const resources = Arr.flatMap(connectors, (c): ReadonlyArray<IntegrationResource> => {
		const scope = `${c.scopeType} ${c.scopeId}`
		const notRun = c.setupReportedAt === null ? "the setup script has not reported yet" : null
		const logs: ReadonlyArray<IntegrationResource> = c.logsEnabled
			? [
					{
						kind: "logs",
						name: scope,
						// Log pushes can be quiet for hours; silence is the source's to report.
						status:
							c.lastError !== null
								? "failing"
								: c.lastReceivedAt === null
									? "pending"
									: "healthy",
						lastSuccessAt: c.lastReceivedAt,
						lastError: c.lastError,
						note:
							c.appliedLogsEnabled === false
								? "the last setup run did not set up the log sink; run the setup script again"
								: c.lastReceivedAt === null
									? notRun
									: null,
					},
				]
			: []
		if (!c.metricsEnabled) return logs
		const counts = Arr.filter(inputs.gcpResourceCounts, (r) => r.connectorId === c.id)
		const projects = Arr.reduce(counts, 0, (n, r) =>
			r.assetType === GCP_PROJECT_ASSET_TYPE ? n + r.count : n,
		)
		const total = Arr.reduce(counts, 0, (n, r) => n + r.count)
		const metricsState: PollState = {
			lastSuccessAt: c.lastMetricsReceivedAt,
			// A partial read keeps a note but stamps a fresh read; a failed read leaves the old stamp.
			lastErrorAt:
				c.lastMetricsError !== null &&
				(c.lastMetricsReceivedAt === null ||
					now - c.lastMetricsReceivedAt > GCP_METRICS_FAILED_AFTER_MS)
					? now
					: null,
			lastError: c.lastMetricsError,
		}
		const metricsStatus = pollStatus(metricsState, now, POLLER_STALE_MS)
		// A truncated sync keeps a note but stamps a fresh sync; a failed one leaves the hour-old stamp.
		const inventoryStatus: IntegrationStatus =
			c.lastResourcesError !== null &&
			(c.resourcesSyncedAt === null || now - c.resourcesSyncedAt > GCP_RESOURCES_FAILED_AFTER_MS)
				? "failing"
				: c.resourcesSyncedAt === null
					? "pending"
					: now - c.resourcesSyncedAt > GCP_INVENTORY_STALE_MS
						? "stale"
						: "healthy"
		return [
			...logs,
			{
				kind: "metrics",
				name: scope,
				status: metricsStatus,
				lastSuccessAt: c.lastMetricsReceivedAt,
				lastError: failingError(metricsState, metricsStatus),
				note:
					c.appliedMetricsEnabled === false
						? "the last setup run did not grant metric reads; run the setup script again"
						: c.lastMetricsReceivedAt === null
							? notRun
							: null,
			},
			{
				kind: "inventory",
				name: scope,
				status: inventoryStatus,
				lastSuccessAt: c.resourcesSyncedAt,
				lastError: c.lastResourcesError,
				note: `${projects} project${projects === 1 ? "" : "s"}, ${total - projects} resource${total - projects === 1 ? "" : "s"}`,
			},
		]
	})
	return entry("gcp", now, {
		account: Arr.join(
			Arr.map(connectors, (c) => `${c.scopeType} ${c.scopeId}`),
			", ",
		),
		connectedAt: Math.min(...Arr.map(connectors, (c) => c.createdAt)),
		resources,
	})
}

const sameModules = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && Arr.every(a, (module) => b.includes(module))

const aws = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const connections = inputs.awsConnections
	if (connections.length === 0) return null
	const resources = Arr.flatMap(connections, (c): ReadonlyArray<IntegrationResource> => {
		const outdated =
			c.grantedModules !== null &&
			(c.templateVersion !== AWS_TEMPLATE_VERSION || !sameModules(c.modules, c.grantedModules))
		// Before the first check that assumed the role, the setup is still being done.
		const role: IntegrationResource =
			c.verifiedAt === null
				? {
						kind: "role",
						name: c.accountId,
						status: "pending",
						lastSuccessAt: null,
						lastError: null,
						note: c.lastCheckError ?? "the setup has not been deployed yet",
					}
				: {
						kind: "role",
						name: c.accountId,
						status: c.lastCheckError === null ? "healthy" : "failing",
						lastSuccessAt: c.lastCheckError === null ? c.lastCheckedAt : null,
						lastError: c.lastCheckError,
						note: outdated
							? "the deployed setup is out of date; run the setup script again"
							: null,
					}
		const state = awsStreamState(
			{
				verifiedAt: c.verifiedAt,
				metricStream: c.metricStream,
				metricStreamChangedAt: c.metricStreamChangedAt,
				metricsLastReceivedAt: c.streamLastReceivedAt,
				metricsLastError: c.streamLastError,
			},
			now,
		)
		const regions = c.metricStream === null ? null : Arr.join(c.metricStream.regions, ", ")
		const stream = (status: IntegrationStatus, lastError: string | null, note: string | null) => [
			{
				kind: "metric stream",
				name: c.accountId,
				status,
				lastSuccessAt: c.streamLastReceivedAt,
				lastError,
				note,
			} satisfies IntegrationResource,
		]
		const streams = ((): ReadonlyArray<IntegrationResource> => {
			switch (state._tag) {
				case "off":
					return c.verifiedAt === null ? [] : stream("paused", null, AWS_METRICS_OFF)
				case "waiting":
					return stream("pending", null, `waiting for the first delivery (${regions})`)
				case "undelivered":
					return stream("failing", AWS_NO_DELIVERY, regions)
				case "refused":
					return stream("failing", state.error, regions)
				case "silent":
				case "delivering":
					return stream(state._tag === "silent" ? "stale" : "healthy", null, regions)
			}
		})()
		return [role, ...streams]
	})
	return entry("aws", now, {
		account: Arr.join(
			Arr.map(connections, (c) => c.accountId),
			", ",
		),
		connectedAt: Math.min(...Arr.map(connections, (c) => c.createdAt)),
		resources,
	})
}

/** Supabase's project lifecycle states, as Maple reads them. */
const SUPABASE_PAUSED_STATES: ReadonlySet<string> = new Set(["INACTIVE", "PAUSING", "PAUSED"])
const SUPABASE_FAILED_STATES: ReadonlySet<string> = new Set([
	"ACTIVE_UNHEALTHY",
	"INIT_FAILED",
	"PAUSE_FAILED",
	"RESTORE_FAILED",
	"REMOVED",
])

const supabaseLifecycle = (status: string): IntegrationStatus =>
	status === "ACTIVE_HEALTHY"
		? "healthy"
		: SUPABASE_PAUSED_STATES.has(status)
			? "paused"
			: SUPABASE_FAILED_STATES.has(status)
				? "failing"
				: "pending"

const supabase = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const connection = inputs.supabaseConnection
	if (connection === null) return null
	const oauth = oauthFor(inputs, "supabase")
	const projects = Arr.map(inputs.supabaseProjects, (project): IntegrationResource => {
		const drainError = project.logDrainEnabled ? project.logDrainError : null
		const logsError = project.logsEnabled ? project.logsError : null
		const lifecycle = supabaseLifecycle(project.status)
		// Discovery keeps the shared source fresh, so a log feed that stops is caught by its own age.
		const logs: IntegrationStatus = !project.logsEnabled
			? "healthy"
			: project.logsLastPolledAt === null
				? "pending"
				: lifecycle === "healthy" && now - project.logsLastPolledAt > POLLER_STALE_MS
					? "stale"
					: "healthy"
		const status = worstStatus([
			lifecycle,
			drainError !== null || logsError !== null ? "failing" : "healthy",
			logs,
		])
		return {
			kind: "project",
			name: project.name,
			status,
			lastSuccessAt: project.logsEnabled ? project.logsLastPolledAt : null,
			lastError: drainError ?? logsError,
			note: Arr.join(
				[
					project.region,
					project.status,
					...(project.logDrainEnabled ? ["log drain on"] : []),
					...(project.logsEnabled ? ["logs polled"] : []),
				],
				", ",
			),
		}
	})
	const scrape = Arr.map(
		Arr.filter(
			inputs.scrapeTargets,
			(t) => t.managedBy != null && Str.startsWith("supabase:")(t.managedBy) && t.enabled !== false,
		),
		(t) => scrapeResource(t, now, "metrics scrape"),
	)
	// Discovery clears its error on success, so a set error is the latest outcome.
	const own =
		oauth === undefined || isRevoked(oauth)
			? revokedProblem("Supabase")
			: connection.lastDiscoveryError !== null
				? {
						status: "failing" as const,
						problem: `Project discovery failing: ${connection.lastDiscoveryError}`,
					}
				: connection.lastDiscoveryAt === null
					? { status: "pending" as const, problem: "The first project discovery has not run yet." }
					: undefined
	return entry("supabase", now, {
		account: connection.organizationName,
		connectedAt: connection.createdAt,
		own,
		resources: [...projects, ...scrape],
	})
}

const prometheus = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const targets = Arr.filter(inputs.scrapeTargets, (t) => t.managedBy === null)
	if (targets.length === 0) return null
	return entry("prometheus", now, {
		account: null,
		connectedAt: null,
		resources: Arr.map(targets, (t) => scrapeResource(t, now, "scrape target")),
	})
}

const chat = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const linear = oauthFor(inputs, "linear")
	if (!linear && inputs.chatWorkspaces.length === 0) return null
	const workspaces = Arr.map(inputs.chatWorkspaces, (w): IntegrationResource => ({
		kind: "workspace",
		name: w.name,
		status: "healthy",
		lastSuccessAt: null,
		lastError: null,
		note: w.connector,
	}))
	const linearResource: ReadonlyArray<IntegrationResource> = linear
		? [
				{
					kind: "workspace",
					name: linear.externalAccountName ?? "Linear",
					status: linear.revokedAt === null ? "healthy" : "disconnected",
					lastSuccessAt: null,
					lastError: null,
					note: "linear",
				},
			]
		: []
	const connectedAt = [
		...Arr.map(inputs.chatWorkspaces, (w) => w.createdAt),
		...(linear ? [linear.createdAt] : []),
	]
	return entry("chat", now, {
		account: null,
		connectedAt: Math.min(...connectedAt),
		resources: [...workspaces, ...linearResource],
	})
}

const searchConsole = (inputs: IntegrationInventoryInputs, now: number): IntegrationEntry | null => {
	const oauth = oauthFor(inputs, "google")
	if (oauth === undefined) return null
	const enabled = Arr.filter(inputs.searchConsoleSites, (site) => site.enabled)
	const own = isRevoked(oauth)
		? {
				status: "disconnected" as const,
				problem: "Google revoked Maple's access; reconnect it in Integrations.",
			}
		: enabled.length === 0
			? { status: "pending" as const, problem: "No Search Console property is selected for import." }
			: undefined
	return entry("search_console", now, {
		account: oauth.externalUserEmail,
		connectedAt: oauth.createdAt,
		own,
		resources: Arr.map(enabled, (site): IntegrationResource => ({
			kind: "property",
			name: site.siteUrl,
			status:
				site.lastError !== null
					? "failing"
					: site.lastSyncedAt === null
						? "pending"
						: now - site.lastSyncedAt > SEARCH_CONSOLE_STALE_MS
							? "stale"
							: "healthy",
			lastSuccessAt: site.lastSyncedAt,
			lastError: site.lastError,
			note: null,
		})),
	})
}

/** One builder per provider, so a provider without one fails the typecheck. */
const BUILDERS = {
	github,
	cloudflare,
	gcp,
	aws,
	railway,
	vercel,
	planetscale,
	supabase,
	prometheus,
	chat,
	search_console: searchConsole,
} satisfies Record<
	IntegrationProvider,
	(inputs: IntegrationInventoryInputs, now: number) => IntegrationEntry | null
>

export const buildIntegrationInventory = (
	inputs: IntegrationInventoryInputs,
	now: number,
): IntegrationInventory => {
	const integrations = Arr.filter(
		Arr.map(INTEGRATION_PROVIDERS, (provider) => BUILDERS[provider](inputs, now)),
		(e): e is IntegrationEntry => e !== null,
	)
	const connected = new Set(Arr.map(integrations, (e) => e.provider))
	return {
		integrations,
		available: Arr.map(
			Arr.filter(INTEGRATION_PROVIDERS, (p) => !connected.has(p)),
			(provider) => ({
				provider,
				feeds: INTEGRATION_FEEDS[provider],
			}),
		),
	}
}

/**
 * A provider reads as the worst of its sources and its own resources, so `list_integrations`
 * never reads better than Sources.
 */
export const withSourceHealth = (
	inventory: IntegrationInventory,
	sources: ReadonlyArray<{ readonly platform: string; readonly health: SourceHealthResult }>,
): IntegrationInventory => ({
	...inventory,
	integrations: Arr.map(inventory.integrations, (entry) => {
		const own = Arr.filter(sources, (source) => source.platform === entry.provider)
		if (own.length === 0) return entry
		const status = worstStatus([entry.status, ...Arr.map(own, (source) => source.health.status)])
		const problem =
			Option.getOrUndefined(Arr.findFirst(own, (source) => source.health.status === status))?.health
				.problem ?? entry.problem
		return { ...entry, status, problem: status === "healthy" ? null : problem }
	}),
})
