import {
	fleetSync,
	groupRailwayServices,
	hasConfiguredLimits,
	type RailwayServiceGroup,
	type RailwaySync,
} from "../../../../components/infra/railway/list-model"
import type { RailwayEnvironmentStatus } from "@maple/domain/http"
import { sortRowsByField, type Sort } from "../../../kit/table-sort"
import type { RailwayServiceRow } from "../model"
import type { SortKey } from "./model"
import { Array as Arr, String as Str } from "effect"

// The pure half of `RailwayServiceTable` and `RailwayFleetBand` (components/infra/railway/).

export { fleetSync, hasConfiguredLimits, type RailwayServiceGroup, type RailwaySync }

/** Peak use against the service's own limit, 0..1, or NaN when Railway reported no limit. */
const ofLimit = (peak: number, limit: number) => (limit > 0 ? peak / limit : Number.NaN)

export interface RailwayRowView extends RailwayServiceRow {
	readonly cpuOfLimit: number
	readonly memoryOfLimit: number
	readonly peakOfLimit: number
	readonly displayName: string
}

export const toView = (row: RailwayServiceRow): RailwayRowView => {
	const cpuOfLimit = ofLimit(row.cpuMax, row.cpuLimit)
	const memoryOfLimit = ofLimit(row.memoryMax, row.memoryLimit)
	const finite = Arr.filter([cpuOfLimit, memoryOfLimit], Number.isFinite)
	return {
		...row,
		cpuOfLimit,
		memoryOfLimit,
		peakOfLimit: finite.length > 0 ? Math.max(...finite) : 0,
		displayName: row.serviceName || row.serviceId,
	}
}

/** Sorted rows grouped under their project / environment header. */
export const groupedRows = (
	services: ReadonlyArray<RailwayServiceRow>,
	environments: ReadonlyArray<RailwayEnvironmentStatus>,
	authFailed: boolean,
	sort: Sort<SortKey>,
): ReadonlyArray<RailwayServiceGroup<RailwayRowView>> =>
	groupRailwayServices(sortRowsByField(Arr.map(services, toView), sort), environments, authFailed)

/** The search box: service, project or environment name contains the query. */
export const filterServices = (
	services: ReadonlyArray<RailwayServiceRow>,
	query: string,
): ReadonlyArray<RailwayServiceRow> => {
	const q = Str.toLowerCase(Str.trim(query))
	return Arr.filter(
		services,
		(row) =>
			q === "" ||
			Str.includes(q)(Str.toLowerCase(`${row.serviceName} ${row.projectName} ${row.environmentName}`)),
	)
}

/** Environments the poller hasn't finished a first sync for (`unsyncedEnvironments`). */
export const unsyncedEnvironments = (environments: ReadonlyArray<RailwayEnvironmentStatus>): number =>
	Arr.filter(
		environments,
		(environment) => environment.lastSyncedAt === null && environment.lastError === null,
	).length

/** Railway services idle in the millicore range; three decimals there so they still differ. */
export const formatVcpu = (cores: number): string => {
	if (!Number.isFinite(cores) || cores === 0) return "0"
	if (cores >= 10) return cores.toFixed(0)
	if (cores >= 1) return cores.toFixed(2)
	return cores.toFixed(3)
}

export const rowKey = (row: RailwayServiceRow): string => `${row.environmentId}:${row.serviceId}`
