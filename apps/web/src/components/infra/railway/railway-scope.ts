// A Railway service's use of its own limits, framework-free.

import type { RailwayServiceRow } from "@maple/web-data/warehouse/railway-infra"

import { severityLevel } from "../format"

export type RailwayScope = "saturated" | "elevated" | "unbounded"

/** Peak use against the service's own limit, 0..1, or NaN when Railway reported no limit. */
const ofLimit = (peak: number, limit: number) => (limit > 0 ? peak / limit : Number.NaN)

export interface RailwayRowView extends RailwayServiceRow {
	readonly cpuOfLimit: number
	readonly memoryOfLimit: number
	readonly peakOfLimit: number
	readonly displayName: string
}

export function toView(row: RailwayServiceRow): RailwayRowView {
	const cpuOfLimit = ofLimit(row.cpuMax, row.cpuLimit)
	const memoryOfLimit = ofLimit(row.memoryMax, row.memoryLimit)
	const finite = [cpuOfLimit, memoryOfLimit].filter(Number.isFinite)
	return {
		...row,
		cpuOfLimit,
		memoryOfLimit,
		peakOfLimit: finite.length > 0 ? Math.max(...finite) : 0,
		displayName: row.serviceName || row.serviceId,
	}
}

/** The overview's saturation check. The list no longer scopes by it: see `hasConfiguredLimits`. */
export function railwayInScope(row: RailwayServiceRow, scope: RailwayScope): boolean {
	const view = toView(row)
	const bounded = Number.isFinite(view.cpuOfLimit) || Number.isFinite(view.memoryOfLimit)
	if (scope === "unbounded") return !bounded
	if (!bounded) return false
	const level = severityLevel(view.peakOfLimit)
	return scope === "saturated" ? level === "crit" : level === "warn"
}
