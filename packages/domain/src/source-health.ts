// One health model for every source, read off its `sources` row. The gateway records when data
// arrives (`last_used_at`) and what it refused; an integration's poller reports each tick's outcome
// (`last_poll_*`, `disconnected_at`). A platform's policy says which of the two shows freshness.

import type { SourcePlatform } from "./primitives"

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

export interface SourceResourceCount {
	readonly total: number
	readonly unhealthy: number
}

export interface SourceHealthResult {
	readonly status: SourceHealthStatus
	/** When data last arrived, or the last successful poll; null when never. */
	readonly lastDataAt: number | null
	/** One line on why the source is not healthy; null when it is. */
	readonly problem: string | null
	/** For a source that stands for several resources (zones, repos): how many are not healthy. */
	readonly resources?: SourceResourceCount
}

interface HealthPolicy {
	/** `data`: fresh while data arrives at the gateway. `poll`: fresh while the poller succeeds. */
	readonly freshness: "data" | "poll"
	readonly staleAfterMs: number
}

const MINUTE = 60_000
/** SDKs can go quiet overnight; a day without data is worth a look, not an alarm. */
const PUSH: HealthPolicy = { freshness: "data", staleAfterMs: 24 * 60 * MINUTE }

/** The alerting pollers tick every 5 minutes: six missed ticks is no longer a blip. */
const POLICIES = {
	opentelemetry: PUSH,
	nodejs: PUSH,
	python: PUSH,
	go: PUSH,
	java: PUSH,
	dotnet: PUSH,
	ruby: PUSH,
	php: PUSH,
	rust: PUSH,
	browser: PUSH,
	kubernetes: PUSH,
	docker: PUSH,
	host: PUSH,
	cloudflare_ai_gateway: PUSH,
	claude_code: PUSH,
	prometheus: { freshness: "poll", staleAfterMs: 10 * MINUTE },
	// Analytics are polled and Logpush pushes; a grant may only push. Both arrive at the gateway.
	cloudflare: { freshness: "data", staleAfterMs: 24 * 60 * MINUTE },
	railway: { freshness: "poll", staleAfterMs: 30 * MINUTE },
	// Log forwarding pushes, metrics are polled; a connector may only forward logs.
	gcp: { freshness: "data", staleAfterMs: 24 * 60 * MINUTE },
	// The inventory refreshes hourly; metrics arrive through the managed scrape.
	planetscale: { freshness: "poll", staleAfterMs: 3 * 60 * MINUTE },
	github: { freshness: "poll", staleAfterMs: 24 * 60 * MINUTE },
	// Project discovery runs hourly; metrics (scrape) and logs (drains) arrive later phases.
	supabase: { freshness: "poll", staleAfterMs: 3 * 60 * MINUTE },
} satisfies Record<SourcePlatform, HealthPolicy>

/**
 * Refusals are recent when the gateway stamped one in the last 15 minutes. A source refused even
 * part of the time is failing (data is dropped); with no refusal for 15 minutes it clears itself.
 */
const REFUSAL_WINDOW_MS = 15 * MINUTE

/** The `sources` columns health reads, timestamps in epoch ms. */
export interface SourceHealthInput {
	readonly platform: SourcePlatform
	/** As the gateway applies it: an expired token is rejected even while paused. */
	readonly status: "active" | "paused" | "expired"
	readonly lastUsedAt: number | null
	readonly lastRejectedAt: number | null
	readonly lastRejection: string | null
	readonly lastPollOkAt: number | null
	readonly lastPollError: string | null
	readonly disconnectedAt: number | null
	readonly pollResources: SourceResourceCount | null
	/** Why the integration reads nothing on purpose (a scrape target switched off), or undefined. */
	readonly turnedOff?: string
	/** Replaces the platform's window, for a source whose cadence is its own (a scrape interval). */
	readonly staleAfterMs?: number
}

const latest = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

const formatWindow = (ms: number) =>
	ms >= 60 * MINUTE ? `${Math.round(ms / (60 * MINUTE))} hours` : `${Math.round(ms / MINUTE)} minutes`

export const sourceHealth = (source: SourceHealthInput, now: number): SourceHealthResult => {
	const policy = POLICIES[source.platform]
	const lastDataAt = latest(source.lastUsedAt, source.lastPollOkAt)
	const resources =
		source.pollResources !== null && source.pollResources.total >= 2 ? source.pollResources : undefined
	const result = (status: SourceHealthStatus, problem: string | null): SourceHealthResult =>
		resources === undefined
			? { status, lastDataAt, problem }
			: { status, lastDataAt, problem, resources }

	if (source.status === "expired") return result("disconnected", "The token expired; senders get 401")
	if (source.disconnectedAt !== null) {
		return result("disconnected", source.lastPollError ?? "The integration is disconnected")
	}
	if (source.status === "paused") return result("paused", "Data is dropped while paused")
	if (source.turnedOff !== undefined) return result("paused", source.turnedOff)
	if (source.lastRejectedAt !== null && now - source.lastRejectedAt <= REFUSAL_WINDOW_MS) {
		return result("failing", source.lastRejection ?? "The gateway refused its requests")
	}
	if (source.lastPollError !== null) return result("failing", source.lastPollError)
	if (resources !== undefined && resources.unhealthy > 0) {
		return result("stale", `${resources.unhealthy} of ${resources.total} not up to date`)
	}
	const freshAt = policy.freshness === "data" ? source.lastUsedAt : source.lastPollOkAt
	const staleAfterMs = source.staleAfterMs ?? policy.staleAfterMs
	if (freshAt === null) return result("pending", null)
	if (now - freshAt > staleAfterMs) {
		const what = policy.freshness === "data" ? "No data" : "No successful update"
		return result("stale", `${what} in the last ${formatWindow(staleAfterMs)}`)
	}
	return result("healthy", null)
}

/** Worst first, by `SOURCE_HEALTH_STATUSES`. */
export const worstSourceStatus = (statuses: ReadonlyArray<SourceHealthStatus>): SourceHealthStatus =>
	SOURCE_HEALTH_STATUSES.find((status) => statuses.includes(status)) ?? "healthy"
