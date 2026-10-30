// Setup progression for the PlanetScale integration.
//
// The OAuth grant covers everything: inventory, query insights, webhooks, and
// branch metrics, which Maple polls from PlanetScale's metrics API every 5
// minutes. A service token switches metrics to Prometheus scraping
// (`metrics_auth: "service_token"`); health is derived from whichever source
// the connection uses, so the status row and the Go live checks always agree.
//
// Pure, so the progression rules are testable on their own
// (same shape as branch-selection.ts).

import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"

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

export type LiveCheckId = "access" | "resources" | "first-metrics" | "webhooks"

/** `failed` is not `waiting`: something is wrong and the operator has to act. */
export type LiveCheckState = "done" | "working" | "waiting" | "failed"

export interface LiveCheck {
	readonly id: LiveCheckId
	readonly state: LiveCheckState
	readonly title: string
	/** One line: what happened, or what to do next. */
	readonly detail: string
}

export type LiveHealth = "pending" | "healthy" | "attention"

export interface PlanetScaleSetup {
	/** Go live's checklist: access, resources, first metrics, then webhooks when Maple reports them. */
	readonly checks: ReadonlyArray<LiveCheck>
	/** The grant can't be used: revoked, or it can't read databases. */
	readonly accessBlocked: boolean
	/**
	 * The first scrape or poll hasn't landed. The page polls status while this is
	 * true so "waiting" resolves to "streaming" without a reload.
	 */
	readonly awaitingFirstScrape: boolean
	readonly health: MetricsHealthState
	readonly live: LiveHealth
}

/** What the inventory found, when it has loaded. */
export type InventoryCounts = Readonly<{ databases: number; branches: number }>

/**
 * Derive Go live's checks from the status the page already fetches.
 * Everything here is a function of `status` and the inventory counts: no extra requests, no local state.
 */
export function derivePlanetScaleSetup(
	status: V2PlanetScaleIntegration,
	nowMs: number,
	inventory: InventoryCounts | null = null,
): PlanetScaleSetup {
	const health = metricsHealthState(status, nowMs)
	const viaApi = metricsAuthOf(status) === "api"
	const revoked = status.revoked_at !== null
	// `detected_permissions` is null before the org is bound; absent is unknown, not denied.
	const readDatabasesDenied = status.detected_permissions?.readDatabases === false
	const accessBlocked = revoked || readDatabasesDenied
	const notYetCollected = health === "waiting" || health === "unconfigured"
	const organization = status.organization ?? "your organization"

	const check = (id: LiveCheckId, state: LiveCheckState, title: string, detail: string): LiveCheck => ({
		id,
		state,
		title,
		detail,
	})

	const access = revoked
		? check(
				"access",
				"failed",
				"Authorization revoked",
				"Maple can no longer read this organization. Reconnect to resume collection.",
			)
		: readDatabasesDenied
			? check(
					"access",
					"failed",
					"Can't read databases",
					"The grant is missing the read_databases scope. Reconnect and keep it checked.",
				)
			: check(
					"access",
					"done",
					"Access works",
					viaApi
						? `The grant reads ${organization}`
						: `The grant reads ${organization}, the service token reads metrics endpoints`,
				)

	const resources = accessBlocked
		? check("resources", "waiting", "Databases and branches", "Listed once access is restored.")
		: status.last_inventory_error !== null
			? check("resources", "failed", "Listing databases failed", status.last_inventory_error)
			: status.last_inventory_at === null
				? check("resources", "working", "Listing databases and branches", "Usually within a minute")
				: check(
						"resources",
						"done",
						"Resources found",
						inventory === null
							? "Databases and branches listed"
							: `${countLabel(inventory.databases, "database")}, ${countLabel(inventory.branches, "branch", "branches")}`,
					)

	const metricsTitle = viaApi ? "First poll, branch metrics" : "First scrape, branch metrics"
	const firstMetrics = (() => {
		// Nothing is collected while the grant is broken, so don't spin over it.
		if (accessBlocked && notYetCollected)
			return check("first-metrics", "waiting", metricsTitle, "Starts once access is restored.")
		switch (health) {
			case "healthy":
				return check(
					"first-metrics",
					"done",
					"Branch metrics arriving",
					viaApi ? "Polled from PlanetScale every 5 minutes" : "Scraped with the service token",
				)
			case "degraded":
				return check(
					"first-metrics",
					"failed",
					metricsTitle,
					`${viaApi ? "The last poll failed" : "The last scrape failed"}: ${metricsLastError(status) ?? ""}`,
				)
			case "stalled":
				return check(
					"first-metrics",
					"failed",
					"Branch metrics stopped",
					"Metrics stopped arriving, collection has stalled.",
				)
			default:
				return check(
					"first-metrics",
					"working",
					metricsTitle,
					viaApi ? "Usually within 10 minutes" : "Usually under a minute",
				)
		}
	})()

	const webhooks = status.webhooks ?? null
	const webhookCheck =
		webhooks === null
			? []
			: [
					webhooks.state === "active"
						? check(
								"webhooks",
								"done",
								"Webhooks registered",
								countLabel(webhooks.databases, "database"),
							)
						: webhooks.state === "pending"
							? check(
									"webhooks",
									"working",
									"Registering webhooks",
									`${webhooks.registered_databases} of ${webhooks.databases} databases so far`,
								)
							: webhooks.state === "failing"
								? check(
										"webhooks",
										"failed",
										"Webhooks failing",
										`${webhooks.registered_databases} of ${webhooks.databases} databases. ${webhooks.last_error ?? ""}`.trim(),
									)
								: check(
										"webhooks",
										"failed",
										"Webhooks need reauthorization",
										"This grant predates webhooks. Reconnect so Maple can register them.",
									),
				]

	return {
		checks: [access, resources, firstMetrics, ...webhookCheck],
		accessBlocked,
		awaitingFirstScrape: !accessBlocked && notYetCollected,
		health,
		live:
			accessBlocked || health === "degraded" || health === "stalled"
				? "attention"
				: health === "healthy"
					? "healthy"
					: "pending",
	}
}
