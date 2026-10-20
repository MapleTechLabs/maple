// One health model for every source. Push sources read the gateway's last_used_at; pull sources
// reuse the integration inventory's poller status, so a source and list_integrations agree.

import {
	type IntegrationEntry,
	type IntegrationInventoryInputs,
	type IntegrationStatus,
	scrapeResource,
	worstStatus,
} from "./integration-inventory"

/** Worst first. */
export const SOURCE_HEALTH_STATUSES = [
	"disconnected",
	"failing",
	"stale",
	"paused",
	"pending",
	"healthy",
] as const
export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number]

export interface SourceHealthResult {
	readonly status: SourceHealthStatus
	/** When data last arrived (push) or the last successful poll (pull); null when never. */
	readonly lastDataAt: number | null
	/** One line on why the source is not healthy; null when it is. */
	readonly problem: string | null
	/** For a source that stands for several resources (zones, repos): how many are not healthy. */
	readonly resources?: SourceResourceCount
}

export interface SourceResourceCount {
	readonly total: number
	readonly unhealthy: number
}

const countOf = (resources: ReadonlyArray<{ readonly status: string }>): SourceResourceCount | undefined =>
	resources.length < 2
		? undefined
		: { total: resources.length, unhealthy: resources.filter((resource) => resource.status !== "healthy").length }

/** SDKs can go quiet overnight; a day without data is worth a look, not an alarm. */
const PUSH_STALE_MS = 24 * 60 * 60 * 1000
const GCP_METRICS_STALE_MS = 30 * 60 * 1000
const GCP_METRICS_FAILED_MS = 10 * 60 * 1000

const latest = (...values: ReadonlyArray<number | null>): number | null =>
	values.reduce<number | null>((max, v) => (v !== null && (max === null || v > max) ? v : max), null)

export interface PushSourceState {
	readonly status: "active" | "paused" | "expired"
	readonly lastUsedAt: number | null
	/** The gateway's last refusal (rate limit or disallowed signal) and why; null when none. */
	readonly lastRejectedAt?: number | null
	readonly lastRejection?: string | null
}

/**
 * Refusals are recent when the gateway stamped one in the last 15 minutes. A source refused even
 * part of the time is failing (data is dropped); with no refusal for 15 minutes it clears itself.
 * Accepted requests are not compared: both stamps are written once a minute per instance.
 */
const REFUSAL_WINDOW_MS = 15 * 60 * 1000

const isRejectedNow = (source: PushSourceState, now: number): boolean => {
	const rejectedAt = source.lastRejectedAt ?? null
	return rejectedAt !== null && now - rejectedAt <= REFUSAL_WINDOW_MS
}

export const pushSourceHealth = (source: PushSourceState, now: number): SourceHealthResult => {
	const lastDataAt = source.lastUsedAt
	if (source.status === "expired") {
		return { status: "disconnected", lastDataAt, problem: "The token expired; senders get 401" }
	}
	if (source.status === "paused")
		return { status: "paused", lastDataAt, problem: "Data is dropped while paused" }
	if (isRejectedNow(source, now)) {
		return { status: "failing", lastDataAt, problem: source.lastRejection ?? "The gateway refused its requests" }
	}
	if (lastDataAt === null) return { status: "pending", lastDataAt, problem: null }
	if (now - lastDataAt > PUSH_STALE_MS) {
		return { status: "stale", lastDataAt, problem: "No data in the last 24 hours" }
	}
	return { status: "healthy", lastDataAt, problem: null }
}

const fromIntegrationStatus = (status: IntegrationStatus): SourceHealthStatus => status

/** A provider-wide integration (Cloudflare, Railway, Vercel, PlanetScale, GitHub) as one source. */
export const integrationSourceHealth = (entry: IntegrationEntry | undefined): SourceHealthResult => {
	if (entry === undefined) {
		return { status: "disconnected", lastDataAt: null, problem: "The integration is no longer connected" }
	}
	const health: SourceHealthResult = {
		status: fromIntegrationStatus(entry.status),
		lastDataAt: latest(...entry.resources.map((resource) => resource.lastSuccessAt)),
		problem: entry.problem,
	}
	const resources = countOf(entry.resources)
	return resources === undefined ? health : { ...health, resources }
}

export const scrapeTargetSourceHealth = (
	target: IntegrationInventoryInputs["scrapeTargets"][number],
	now: number,
): SourceHealthResult => {
	const resource = scrapeResource(target, now, "scrape target")
	return {
		status: fromIntegrationStatus(resource.status),
		lastDataAt: resource.lastSuccessAt,
		problem: resource.lastError,
	}
}

export interface GcpConnectorHealthInput {
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
	readonly lastReceivedAt: number | null
	readonly lastError: string | null
	readonly lastMetricsReceivedAt: number | null
	readonly lastMetricsError: string | null
}

/** Coarser than the Google Cloud page's per-capability states: enough to rank a source. */
export const gcpSourceHealth = (connector: GcpConnectorHealthInput, now: number): SourceHealthResult => {
	const lastDataAt = latest(
		connector.logsEnabled ? connector.lastReceivedAt : null,
		connector.metricsEnabled ? connector.lastMetricsReceivedAt : null,
	)
	if (connector.logsEnabled && connector.lastError !== null) {
		return { status: "failing", lastDataAt, problem: connector.lastError }
	}
	const metricsAge =
		connector.lastMetricsReceivedAt === null
			? Number.POSITIVE_INFINITY
			: now - connector.lastMetricsReceivedAt
	if (
		connector.metricsEnabled &&
		connector.lastMetricsError !== null &&
		metricsAge > GCP_METRICS_FAILED_MS
	) {
		return { status: "failing", lastDataAt, problem: connector.lastMetricsError }
	}
	if (lastDataAt === null) return { status: "pending", lastDataAt, problem: null }
	if (connector.metricsEnabled && metricsAge > GCP_METRICS_STALE_MS) {
		return { status: "stale", lastDataAt, problem: "No metrics read in the last 30 minutes" }
	}
	if (!connector.metricsEnabled && now - lastDataAt > PUSH_STALE_MS) {
		return { status: "stale", lastDataAt, problem: "No logs in the last 24 hours" }
	}
	return { status: "healthy", lastDataAt, problem: null }
}

/** One GitHub installation, from the repositories under its account (repo names are `owner/name`). */
export const githubInstallationHealth = (
	entry: IntegrationEntry | undefined,
	accountLogin: string,
): SourceHealthResult => {
	if (entry === undefined) return integrationSourceHealth(undefined)
	const prefix = `${accountLogin.toLowerCase()}/`
	const repos = entry.resources.filter((resource) => resource.name.toLowerCase().startsWith(prefix))
	if (repos.length === 0) return { status: "pending", lastDataAt: null, problem: null }
	const status = worstStatus(repos.map((repo) => repo.status))
	const failing = repos.find((repo) => repo.status === status && repo.lastError !== null)
	const health: SourceHealthResult = {
		status: fromIntegrationStatus(status),
		lastDataAt: latest(...repos.map((repo) => repo.lastSuccessAt)),
		problem:
			status === "healthy"
				? null
				: failing === undefined
					? `Repositories under ${accountLogin} are ${status}`
					: `${failing.name}: ${failing.lastError}`,
	}
	const resources = countOf(repos)
	return resources === undefined ? health : { ...health, resources }
}
