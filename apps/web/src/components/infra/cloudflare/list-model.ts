import { ERROR_RATE_WARN } from "@maple/ui/lib/error-rate"
import type { Tone } from "@maple/ui/lib/tone"

import type {
	CloudflareDurableObjectRow,
	CloudflareWorkerRow,
	CloudflareZoneRow,
} from "@maple/web-data/warehouse/cloudflare-infra"

// Here, not beside the list views: the route's search schema needs it, and it loads at startup.
export const CLOUDFLARE_VIEWS = ["zones", "workers", "queues"] as const
export type CloudflareView = (typeof CLOUDFLARE_VIEWS)[number]

/** Below this many requests a rate is noise: 1 failure in 11 requests is not a 9% error rate. */
export const MIN_RATED_REQUESTS = 500
/** A 4xx share this high is the zone's story, whatever its 5xx rate says. */
export const CLIENT_ERROR_NOTABLE = 0.5
export const SLOW_P99_MS = 1000
export const CPU_HEAVY_P99_MS = 500

export const ZONE_SCOPES = ["serving5xx", "mostly4xx", "lowVolume"] as const
export type ZoneScope = (typeof ZONE_SCOPES)[number]

export const WORKER_SCOPES = ["erroring", "slow", "cpuHeavy"] as const
export type WorkerScope = (typeof WORKER_SCOPES)[number]

export type ZoneHealth = "serving5xx" | "mostly4xx" | "ok" | "lowVolume"

/** One rule for the list row and the detail header, so a zone never reads differently on each. */
export const ZONE_HEALTH_TONE = {
	serving5xx: "crit",
	mostly4xx: "warn",
	ok: "ok",
	lowVolume: "neutral",
} as const satisfies Record<ZoneHealth, Tone>

export function classifyZone(requests: number, serverErrorRate: number, clientErrorRate: number): ZoneHealth {
	if (requests < MIN_RATED_REQUESTS) return "lowVolume"
	if (serverErrorRate >= ERROR_RATE_WARN) return "serving5xx"
	if (clientErrorRate >= CLIENT_ERROR_NOTABLE) return "mostly4xx"
	return "ok"
}

export function zoneHealth(zone: CloudflareZoneRow): ZoneHealth {
	return classifyZone(zone.requests, zone.errorRate, zone.clientErrorRate)
}

export function zoneInScope(zone: CloudflareZoneRow, scope: ZoneScope): boolean {
	return zoneHealth(zone) === scope
}

/** One row per Worker script, with its Durable Object calls folded in. */
export interface WorkerListRow {
	scriptName: string
	serviceName: string
	accountId: string
	/** The same script name also runs in another account; rows must say which is which. */
	nameInOtherAccounts: boolean
	requests: number
	errors: number
	/** Invocation error ratio, 0-1. */
	errorRate: number
	cpuP50Ms: number
	cpuP99Ms: number
	durationP50Ms: number
	durationP99Ms: number
	doRequests: number
	doErrors: number
	/** Durable Object error ratio, 0-1. */
	doErrorRate: number
	/** A per-PR deploy (`-pr-123`), hidden by default so it doesn't pad the list. */
	isPreview: boolean
}

const PREVIEW_SUFFIX = /-pr-\d+$/

const workerKey = (row: { accountId: string; scriptName: string }) => `${row.accountId}|${row.scriptName}`

/** Stable identity for a Worker row: the script name alone collides across accounts. */
export const workerRowKey = workerKey

/**
 * Workers and Durable Objects are keyed by the same (account, script), so a failing DO belongs on
 * its Worker's row. Scripts that only host DOs (no invocations of their own) still get a row.
 */
export function mergeWorkerRows(
	workers: ReadonlyArray<CloudflareWorkerRow>,
	durableObjects: ReadonlyArray<CloudflareDurableObjectRow>,
): WorkerListRow[] {
	const doByWorker = new Map(durableObjects.map((row) => [workerKey(row), row]))
	const merged: Array<Omit<WorkerListRow, "nameInOtherAccounts">> = workers.map((worker) => {
		const durable = doByWorker.get(workerKey(worker))
		doByWorker.delete(workerKey(worker))
		return {
			scriptName: worker.scriptName,
			serviceName: worker.serviceName,
			accountId: worker.accountId,
			requests: worker.requests,
			errors: worker.errors,
			errorRate: worker.errorRate,
			cpuP50Ms: worker.cpuP50Ms,
			cpuP99Ms: worker.cpuP99Ms,
			durationP50Ms: worker.durationP50Ms,
			durationP99Ms: worker.durationP99Ms,
			doRequests: durable?.requests ?? 0,
			doErrors: durable?.errors ?? 0,
			doErrorRate: durable?.errorRate ?? 0,
			isPreview: PREVIEW_SUFFIX.test(worker.scriptName),
		}
	})
	for (const durable of doByWorker.values()) {
		merged.push({
			scriptName: durable.scriptName,
			serviceName: durable.serviceName,
			accountId: durable.accountId,
			requests: 0,
			errors: 0,
			errorRate: 0,
			cpuP50Ms: 0,
			cpuP99Ms: 0,
			durationP50Ms: 0,
			durationP99Ms: 0,
			doRequests: durable.requests,
			doErrors: durable.errors,
			doErrorRate: durable.errorRate,
			isPreview: PREVIEW_SUFFIX.test(durable.scriptName),
		})
	}
	const accountsPerName = new Map<string, Set<string>>()
	for (const row of merged) {
		accountsPerName.set(
			row.scriptName,
			(accountsPerName.get(row.scriptName) ?? new Set()).add(row.accountId),
		)
	}
	return merged.map((row) => ({
		...row,
		nameInOtherAccounts: (accountsPerName.get(row.scriptName)?.size ?? 0) > 1,
	}))
}

export type WorkerHealth = "erroring" | "slow" | "ok"

export const WORKER_HEALTH_TONE = {
	erroring: "crit",
	slow: "warn",
	ok: "ok",
} as const satisfies Record<WorkerHealth, Tone>

export function workerHealth(row: WorkerListRow): WorkerHealth {
	if (row.errorRate >= ERROR_RATE_WARN || row.doErrorRate >= ERROR_RATE_WARN) return "erroring"
	if (row.durationP99Ms >= SLOW_P99_MS) return "slow"
	return "ok"
}

export function workerInScope(row: WorkerListRow, scope: WorkerScope): boolean {
	switch (scope) {
		case "erroring":
			return workerHealth(row) === "erroring"
		case "slow":
			return row.durationP99Ms >= SLOW_P99_MS
		case "cpuHeavy":
			return row.cpuP99Ms >= CPU_HEAVY_P99_MS
	}
}

const HEALTH_RANK = { erroring: 0, slow: 1, ok: 2 } satisfies Record<WorkerHealth, number>

/** Within a health group: worst rate for erroring, slowest p99 for slow, busiest otherwise. */
const severityWithin = (row: WorkerListRow): number => {
	switch (workerHealth(row)) {
		case "erroring":
			return Math.max(row.errorRate, row.doErrorRate)
		case "slow":
			return row.durationP99Ms
		case "ok":
			return row.requests + row.doRequests
	}
}

/** Problems first, worst first. Sorting by volume alone buried a 100%-failing Worker at row 24. */
export function sortWorkersByAttention(rows: ReadonlyArray<WorkerListRow>): WorkerListRow[] {
	return rows.toSorted(
		(a, b) =>
			HEALTH_RANK[workerHealth(a)] - HEALTH_RANK[workerHealth(b)] ||
			severityWithin(b) - severityWithin(a),
	)
}
