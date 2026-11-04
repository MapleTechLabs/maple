// What each connected integration is, what it feeds, and whether it is working. Pure: one IO pass
// fills `IntegrationInventoryInputs` (narrow column projections, epoch ms), then
// `buildIntegrationInventory` derives every status, same shape as `./setup-audit`.

import {
	SOURCE_HEALTH_STATUSES,
	type SourceHealthResult,
	type SourceHealthStatus,
	worstSourceStatus,
} from "./source-health"
import { redactUrlSecrets } from "./url-redaction"
import { Array as Arr, Record as Rec, String as Str } from "effect"

export const INTEGRATION_PROVIDERS = [
	"github",
	"cloudflare",
	"railway",
	"vercel",
	"planetscale",
	"prometheus",
	"chat",
] as const
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]

/** Worst first: a provider takes the worst status of its sources and resources. Same as a source's. */
export const INTEGRATION_STATUSES = SOURCE_HEALTH_STATUSES
export type IntegrationStatus = SourceHealthStatus

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
const SCRAPE_MIN_STALE_MS = 10 * 60 * 1000

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
				readonly logDrainState: VercelDrainSnapshot | null
				readonly traceDrainState: VercelDrainSnapshot | null
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
}

/** What the poller last saw of one Vercel drain. */
export interface VercelDrainSnapshot {
	readonly status: string
	readonly lastError: string | null
}

export interface IntegrationResource {
	readonly kind: string
	readonly name: string
	readonly status: IntegrationStatus
	readonly lastSuccessAt: number | null
	readonly lastError: string | null
	readonly note: string | null
}

export interface IntegrationEntry {
	readonly provider: IntegrationProvider
	readonly status: IntegrationStatus
	readonly account: string | null
	readonly connectedAt: number | null
	/** One line on why the provider is not healthy; null when it is. */
	readonly problem: string | null
	/** The Maple data and tools this integration feeds. */
	readonly feeds: ReadonlyArray<string>
	readonly resources: ReadonlyArray<IntegrationResource>
}

export interface IntegrationInventory {
	readonly integrations: ReadonlyArray<IntegrationEntry>
	/** Providers with nothing connected, and what connecting them would feed. */
	readonly available: ReadonlyArray<{
		readonly provider: IntegrationProvider
		readonly feeds: ReadonlyArray<string>
	}>
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
	prometheus: ["metrics scraped from Prometheus endpoints (list_metrics)"],
	chat: ["the Maple bot in chat workspaces", "alert issues and comments in Linear"],
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
const summarizeResources = (resources: ReadonlyArray<IntegrationResource>): string | null => {
	const unhealthy = Arr.filter(resources, (r) => r.status !== "healthy")
	if (unhealthy.length === 0) return null
	const worst = worstStatus(Arr.map(unhealthy, (r) => r.status))
	const ofWorst = Arr.filter(unhealthy, (r) => r.status === worst)
	const example = ofWorst.find((r) => r.lastError !== null) ?? ofWorst[0]
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
	const resources = Arr.map(fields.resources, (r) => withAge(r, now))
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
		resources: [...resources].sort(
			(a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || Str.localeCompare(b.name)(a.name),
		),
	}
}

const oauthFor = (inputs: IntegrationInventoryInputs, provider: string) =>
	inputs.oauthConnections.find((c) => c.provider === provider)

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
						problem:
							"Authorized, but no PlanetScale organization is selected yet; pick one in Sources.",
					},
			resources: [],
		})
	}
	const databases = Arr.map(inputs.planetscaleDatabases, (db): IntegrationResource => {
		const states = Arr.filter(inputs.planetscalePollStates, (s) => s.databaseId === db.databaseId)
		const statuses = Arr.map(states, (s) => pollStatus(s, now, PLANETSCALE_STALE_MS))
		const status = states.length === 0 ? "healthy" : worstStatus(statuses)
		const failing = states.find((_, i) => statuses[i] === "failing")
		return {
			kind: "database",
			name: db.name,
			status,
			lastSuccessAt: states.reduce<number | null>(
				(latest, s) =>
					s.lastSuccessAt !== null && (latest === null || s.lastSuccessAt > latest)
						? s.lastSuccessAt
						: latest,
				null,
			),
			lastError: failing?.lastError ?? null,
			note: [db.kind, db.region, db.state].filter((part) => part !== null && part !== "").join(", "),
		}
	})
	// A disabled managed target only holds branch filters: metrics come from the metrics API.
	const scrape = Arr.map(
		inputs.scrapeTargets.filter((t) => t.managedBy?.startsWith("planetscale:") && t.enabled !== false),
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
	PLANETSCALE_PERMISSION_FEEDS.find(([key]) => key === permission)?.[1] ?? "unknown use"

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

export const buildIntegrationInventory = (
	inputs: IntegrationInventoryInputs,
	now: number,
): IntegrationInventory => {
	const integrations = Arr.filter(
		[
			github(inputs, now),
			cloudflare(inputs, now),
			railway(inputs, now),
			vercel(inputs, now),
			planetscale(inputs, now),
			prometheus(inputs, now),
			chat(inputs, now),
		],
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
		const problem = own.find((source) => source.health.status === status)?.health.problem ?? entry.problem
		return { ...entry, status, problem: status === "healthy" ? null : problem }
	}),
})
