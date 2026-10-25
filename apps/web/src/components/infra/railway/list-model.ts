import type { RailwayEnvironmentStatus } from "@maple/domain/http"

import type { RailwayServiceRow } from "@maple/web-data/warehouse/railway-infra"

/** Where a group's poller stands, read off the integration status for its environment. */
export type RailwaySync =
	| { readonly kind: "synced"; readonly at: number }
	| { readonly kind: "failing"; readonly error: string; readonly lastSyncedAt: number | null }
	| { readonly kind: "pending" }
	/** Token rejected: every environment stopped at once, so no group is singled out. */
	| { readonly kind: "paused"; readonly lastSyncedAt: number | null }
	/** Metrics exist but the environment is no longer in status (removed, or disabled). */
	| { readonly kind: "unknown" }

/** One project / environment, Railway's own unit: a project canvas in one environment. */
export interface RailwayServiceGroup<R extends RailwayServiceRow = RailwayServiceRow> {
	readonly key: string
	readonly projectName: string
	readonly environmentName: string
	readonly services: ReadonlyArray<R>
	/** Sum of the services' average memory, bytes. */
	readonly memoryAvg: number
	readonly sync: RailwaySync
}

function syncOf(environment: RailwayEnvironmentStatus | undefined, authFailed: boolean): RailwaySync {
	if (environment === undefined) return { kind: "unknown" }
	if (authFailed) return { kind: "paused", lastSyncedAt: environment.lastSyncedAt }
	if (environment.lastError !== null) {
		return { kind: "failing", error: environment.lastError, lastSyncedAt: environment.lastSyncedAt }
	}
	if (environment.lastSyncedAt === null) return { kind: "pending" }
	return { kind: "synced", at: environment.lastSyncedAt }
}

const sumMemory = (services: ReadonlyArray<RailwayServiceRow>) =>
	services.reduce((total, row) => total + row.memoryAvg, 0)

/** Groups by environment (ids are unique across projects), heaviest group first. */
export function groupRailwayServices<R extends RailwayServiceRow>(
	services: ReadonlyArray<R>,
	environments: ReadonlyArray<RailwayEnvironmentStatus>,
	authFailed: boolean,
): ReadonlyArray<RailwayServiceGroup<R>> {
	const byEnvironment = new Map<string, Array<R>>()
	for (const row of services) {
		const bucket = byEnvironment.get(row.environmentId)
		if (bucket === undefined) byEnvironment.set(row.environmentId, [row])
		else bucket.push(row)
	}
	const statusById = new Map(environments.map((environment) => [environment.environmentId, environment]))
	return [...byEnvironment.entries()]
		.map(([environmentId, rows]): RailwayServiceGroup<R> => {
			const status = statusById.get(environmentId)
			return {
				key: environmentId,
				projectName: rows[0]?.projectName || status?.projectName || "",
				environmentName: rows[0]?.environmentName || status?.environmentName || "",
				services: rows,
				memoryAvg: sumMemory(rows),
				sync: syncOf(status, authFailed),
			}
		})
		.sort((a, b) => b.memoryAvg - a.memoryAvg)
}

/**
 * Railway reports the plan's per-service ceiling as the limit when nobody set one, so every
 * service on a plan carries the same number and "of limit" reads ~1% forever. A limit only
 * says something when it differs from the rest of the fleet.
 */
export function hasConfiguredLimits(services: ReadonlyArray<RailwayServiceRow>): boolean {
	const distinct = (pick: (row: RailwayServiceRow) => number) =>
		new Set(services.map(pick).filter((limit) => limit > 0)).size > 1
	return distinct((row) => row.cpuLimit) || distinct((row) => row.memoryLimit)
}

/** Fleet-wide polling state for the band: the worst environment wins. */
export function fleetSync(
	environments: ReadonlyArray<RailwayEnvironmentStatus>,
	authFailed: boolean,
): { readonly failing: number; readonly pending: number; readonly lastSyncedAt: number | null } {
	let failing = 0
	let pending = 0
	let lastSyncedAt: number | null = null
	for (const environment of environments) {
		const sync = syncOf(environment, authFailed)
		if (sync.kind === "failing" || sync.kind === "paused") failing += 1
		if (sync.kind === "pending") pending += 1
		if (
			environment.lastSyncedAt !== null &&
			(lastSyncedAt === null || environment.lastSyncedAt > lastSyncedAt)
		) {
			lastSyncedAt = environment.lastSyncedAt
		}
	}
	return { failing, pending, lastSyncedAt }
}
