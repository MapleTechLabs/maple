/**
 * Cloud SQL instance settings from Cloud Asset Inventory, as the inventory row's `details`: engine,
 * size, availability, Query Insights, and the connection limit.
 */
import type { GcpCloudSqlSettings } from "@maple/domain/http"
import type { GcpSqlInstanceData } from "./api"

/** Memory and vCPUs of a tier, for the tiers whose name says so. Shared-core tiers have no whole vCPU. */
const tierSize = (tier: string): { readonly cpus: number | null; readonly memoryGb: number } | undefined => {
	if (tier === "db-f1-micro") return { cpus: null, memoryGb: 0.6 }
	if (tier === "db-g1-small") return { cpus: null, memoryGb: 1.7 }
	const custom = /^db-custom-(\d+)-(\d+)$/.exec(tier)
	if (custom) return { cpus: Number(custom[1]), memoryGb: Number(custom[2]) / 1024 }
	const n1 = /^db-n1-(standard|highmem)-(\d+)$/.exec(tier)
	if (n1) {
		const cpus = Number(n1[2])
		return { cpus, memoryGb: cpus * (n1[1] === "standard" ? 3.75 : 6.5) }
	}
	// Enterprise Plus: 8 GB per vCPU.
	const performance = /^db-perf-optimized-N-(\d+)$/.exec(tier)
	if (performance) return { cpus: Number(performance[1]), memoryGb: Number(performance[1]) * 8 }
	return undefined
}

/**
 * PostgreSQL's default `max_connections` on Cloud SQL by the memory of the largest instance in
 * the chain of primaries, from the database flags reference: the first row at or below it.
 */
const POSTGRES_DEFAULT_MAX_CONNECTIONS: ReadonlyArray<readonly [minimumGb: number, connections: number]> = [
	[120, 1_000],
	[60, 800],
	[30, 600],
	[15, 500],
	[7.5, 400],
	[6, 200],
	[3.75, 100],
	[1, 50],
	[0, 25],
]

const numberOrNull = (value: string | undefined) => {
	const parsed = value === undefined ? Number.NaN : Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

/** Each instance's settings, by its full resource name. */
export const gcpSqlSettings = (
	instances: ReadonlyArray<{ readonly name: string; readonly data: GcpSqlInstanceData }>,
): Array<readonly [name: string, settings: GcpCloudSqlSettings]> => {
	const memoryOf = new Map(
		instances.map(({ data }) => [
			`${data.project}:${data.name}`,
			tierSize(data.settings?.tier ?? "")?.memoryGb,
		]),
	)
	return instances.map(({ name, data }) => {
		const settings = data.settings
		const size = tierSize(settings?.tier ?? "")
		const flag = numberOrNull(
			settings?.databaseFlags?.find((databaseFlag) => databaseFlag.name === "max_connections")?.value,
		)
		// A replica takes its primary's default when the primary is larger.
		const memoryGb = Math.max(
			size?.memoryGb ?? Number.NEGATIVE_INFINITY,
			memoryOf.get(data.masterInstanceName ?? "") ?? Number.NEGATIVE_INFINITY,
		)
		const defaultLimit =
			data.databaseVersion?.startsWith("POSTGRES") && Number.isFinite(memoryGb)
				? POSTGRES_DEFAULT_MAX_CONNECTIONS.find(([minimumGb]) => memoryGb >= minimumGb)?.[1]
				: undefined
		return [
			name,
			{
				databaseVersion: data.databaseVersion ?? null,
				edition: settings?.edition ?? null,
				tier: settings?.tier ?? null,
				cpus: size?.cpus ?? null,
				memoryGb: size?.memoryGb ?? null,
				availabilityType: settings?.availabilityType ?? null,
				primary: data.masterInstanceName ?? null,
				diskSizeGb: numberOrNull(settings?.dataDiskSizeGb),
				queryInsightsEnabled: settings?.insightsConfig?.queryInsightsEnabled === true,
				maxConnections: flag ?? defaultLimit ?? null,
				maxConnectionsSource: flag !== null ? "flag" : defaultLimit !== undefined ? "default" : null,
			},
		] as const
	})
}
