// Setup progression for the PlanetScale integration.
//
// The OAuth grant covers everything: inventory, query insights, webhooks, and
// branch metrics, which Maple polls from PlanetScale's metrics API every 5
// minutes. Older connections may still scrape Prometheus with a service token
// (`metrics_auth: "service_token"`); health is derived from whichever source
// the connection uses, so the status row and the checklist always agree.
//
// Pure, so the progression rules are testable on their own
// (same shape as branch-selection.ts).

import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"

/** Where branch metrics come from. Legacy wire values ("oauth", "missing") mean the API poller. */
export type MetricsAuth = "api" | "service_token"

type MetricsStatus = Pick<V2PlanetScaleIntegration, "metrics_auth" | "api_metrics" | "scrape_target">

export const metricsAuthOf = (status: Pick<V2PlanetScaleIntegration, "metrics_auth">): MetricsAuth =>
	status.metrics_auth === "service_token" ? "service_token" : "api"

/** The poller runs every 5 minutes and reads up to 2 behind, so 20 minutes of silence is a fault. */
const API_POLL_STALL_MS = 20 * 60 * 1000

/**
 * Outcome-level health of branch-metrics collection. One machine, shared by the
 * status row and the setup checklist, so the two can never disagree about
 * whether metrics are flowing.
 *
 * `unconfigured` is distinct from `waiting`: a service-token connection whose
 * scrape target row is missing, versus collection that hasn't landed yet.
 */
export type MetricsHealthState = "unconfigured" | "waiting" | "healthy" | "stalled" | "degraded"

/** When metrics last landed, from whichever source the connection uses. */
export const metricsLastCollectedAt = (status: MetricsStatus): string | null =>
	metricsAuthOf(status) === "service_token"
		? (status.scrape_target?.last_scrape_at ?? null)
		: (status.api_metrics?.last_polled_at ?? null)

/** The most recent collection error, from whichever source the connection uses. */
export const metricsLastError = (status: MetricsStatus): string | null =>
	metricsAuthOf(status) === "service_token"
		? (status.scrape_target?.last_scrape_error ?? null)
		: (status.api_metrics?.last_error ?? null)

export function metricsHealthState(status: MetricsStatus, nowMs: number): MetricsHealthState {
	const target = status.scrape_target
	if (metricsAuthOf(status) === "service_token" && target === null) return "unconfigured"
	if (metricsLastError(status) !== null) return "degraded"
	const lastAt = metricsLastCollectedAt(status)
	if (lastAt === null) return "waiting"
	// Scrapes: three intervals of silence, since one missed scrape is jitter.
	const stallMs =
		target !== null && metricsAuthOf(status) === "service_token"
			? 3 * target.scrape_interval_seconds * 1000
			: API_POLL_STALL_MS
	return nowMs - Date.parse(lastAt) > stallMs ? "stalled" : "healthy"
}

/** Collection broke after working: an error, or silence well past the cadence. */
export const metricsCollectionFailing = (status: MetricsStatus, nowMs: number): boolean => {
	const state = metricsHealthState(status, nowMs)
	return state === "degraded" || state === "stalled"
}

/**
 * No branch metric has ever been collected for this connection, as opposed to
 * "collection broke", which still has history worth rendering.
 *
 * The infra pages branch on this: never-collected shows the setup card instead
 * of a stat rail full of dashes. Once metrics have landed the pages render
 * normally, and degradation is carried by the inline notices instead.
 */
export const metricsNeverCollected = (status: V2PlanetScaleIntegration): boolean =>
	metricsLastCollectedAt(status) === null

export type SetupStepId = "connected" | "permissions" | "first-metrics"

/**
 * `blocked` is not `pending`: something is wrong and the operator has to act.
 * `current` is the one step the card expands.
 */
export type SetupStepState = "done" | "current" | "blocked" | "pending"

export interface SetupStep {
	readonly id: SetupStepId
	readonly title: string
	readonly state: SetupStepState
	/** One line: what happened, or what to do next. Rendered under the title. */
	readonly detail: string
	/**
	 * The step is `current` because Maple is working, not because the operator
	 * is. Drives whether the marker spins — a spinner next to a step that is
	 * waiting on a paste reads as "don't touch this", which is the opposite of
	 * what it means.
	 */
	readonly waitingOnMaple: boolean
}

export interface PlanetScaleSetup {
	readonly steps: ReadonlyArray<SetupStep>
	/** Every step done — the card collapses to its quiet connected form. */
	readonly complete: boolean
	/**
	 * The first scrape or poll hasn't landed. The card polls status while this is
	 * true so "waiting" resolves to "streaming" without a reload.
	 */
	readonly awaitingFirstScrape: boolean
	readonly health: MetricsHealthState
	/** 1-based index of the `current`/`blocked` step, or null once complete. */
	readonly activeStepNumber: number | null
}

/**
 * Derive the three-step progression from the status the card already fetches.
 * Everything here is a function of `status` — no extra requests, no local state.
 */
export function derivePlanetScaleSetup(status: V2PlanetScaleIntegration, nowMs: number): PlanetScaleSetup {
	const health = metricsHealthState(status, nowMs)
	const viaApi = metricsAuthOf(status) === "api"
	const revoked = status.revoked_at !== null
	// `detected_permissions` is null before the org is bound; absent is unknown,
	// not denied — only an explicit `false` blocks.
	const readDatabasesDenied = status.detected_permissions?.readDatabases === false

	const step = (
		id: SetupStepId,
		title: string,
		state: SetupStepState,
		detail: string,
		waitingOnMaple = false,
	): SetupStep => ({ id, title, state, detail, waitingOnMaple })

	const connected = revoked
		? step(
				"connected",
				"Authorization",
				"blocked",
				"The PlanetScale authorization was revoked — reconnect to resume collection.",
			)
		: step(
				"connected",
				"Authorization",
				"done",
				status.organization !== null
					? `Connected to ${status.organization}`
					: "OAuth authorization stored",
			)

	const permissions = revoked
		? step("permissions", "Permissions", "pending", "Checked once the authorization is restored.")
		: readDatabasesDenied
			? step(
					"permissions",
					"Permissions",
					"blocked",
					"The authorization can't read databases — grant the read_databases scope, then reconnect.",
				)
			: step("permissions", "Permissions", "done", "Inventory, query insights, and webhooks are live.")

	const upstreamBlocked = revoked || readDatabasesDenied
	const notYetCollected = health === "waiting" || health === "unconfigured"

	const firstMetrics = ((): SetupStep => {
		const title = "Metrics arriving"
		// Nothing is collected while the grant is broken, so don't spin over it.
		if (upstreamBlocked && notYetCollected) {
			return step("first-metrics", title, "pending", "Starts once the authorization is restored.")
		}
		switch (health) {
			case "healthy":
				return step("first-metrics", title, "done", "Streaming branch metrics.")
			case "degraded":
				return step(
					"first-metrics",
					title,
					"blocked",
					viaApi ? "The last poll failed." : "The last scrape failed.",
				)
			case "stalled":
				return step(
					"first-metrics",
					title,
					"blocked",
					"Metrics stopped arriving, collection has stalled.",
				)
			default:
				// Nothing is asked of the operator: Maple is collecting and the first
				// sample hasn't landed.
				return step(
					"first-metrics",
					title,
					"current",
					viaApi
						? "Waiting for the first poll. Maple polls PlanetScale every 5 minutes."
						: "Waiting for the first scrape.",
					true,
				)
		}
	})()

	const steps = [connected, permissions, firstMetrics]
	const activeIndex = steps.findIndex((step) => step.state === "current" || step.state === "blocked")

	return {
		steps,
		complete: activeIndex === -1,
		awaitingFirstScrape: !upstreamBlocked && notYetCollected,
		health,
		activeStepNumber: activeIndex === -1 ? null : activeIndex + 1,
	}
}
