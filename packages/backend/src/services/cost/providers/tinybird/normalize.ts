// Tinybird usage as estimated `cost_daily` rows: vCPU overage, storage and data transfer priced at
// Tinybird's public list prices. Tinybird has no spend API, so no row is what Tinybird billed.
import { Array as Arr, DateTime, Record as Rec, Result } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { ComputeDay, StorageDay, TransferDay, Workspace } from "./tinybird-cost-api"

// List prices from tinybird.co/pricing, checked 2026-11-14.
/** USD per vCPU-second used above the plan's vCPUs. */
export const VCPU_OVERAGE_USD_PER_SECOND = 0.0002
/** USD per GB-month stored (GB = 1e9 bytes), counted on each day's largest size. */
export const STORAGE_USD_PER_GB_MONTH = 0.058
/** USD per GB moved within a region. */
export const INTRA_REGION_TRANSFER_USD_PER_GB = 0.01
/** USD per GB moved between regions. */
export const INTER_REGION_TRANSFER_USD_PER_GB = 0.1

const GB = 1e9
const CATEGORY = "Analytics"

export interface TinybirdUsage {
	readonly workspaces: ReadonlyArray<Workspace>
	readonly compute: ReadonlyArray<ComputeDay>
	readonly storage: ReadonlyArray<StorageDay>
	readonly transfer: ReadonlyArray<TransferDay>
}

/** Days in `day`'s UTC month. */
const daysInMonth = (day: string): number =>
	DateTime.getPartUtc(DateTime.endOf(DateTime.makeUnsafe(`${day}T00:00:00Z`), "month"), "day")

// NUL cannot be in a day or a name, so the key keeps the parts apart.
const keyOf = (parts: ReadonlyArray<string>): string => Arr.join(parts, "\u0000")

/**
 * The window's rows. A day from `openDay` on can still change. Rows of one key (two workspaces of
 * one name) are summed: the warehouse reads by that key, so two rows would count once.
 */
export const toCostRows = (
	usage: TinybirdUsage,
	account: { readonly accountId: string; readonly region: string },
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const names = new Map(Arr.map(usage.workspaces, (workspace) => [workspace.workspace_id, workspace.name]))
	const workspaceName = (id: string) => names.get(id) ?? id

	const row = (
		day: string,
		parts: Pick<
			CostPullRow,
			"cloudService" | "usageType" | "resourceId" | "resourceType" | "consumedUnit"
		>,
		quantity: number,
		cost: number,
	): CostPullRow => ({
		day,
		accountId: account.accountId,
		serviceCategory: CATEGORY,
		region: account.region,
		serviceName: "",
		chargeCategory: "usage",
		basis: "estimated",
		currency: "USD",
		billedCost: cost,
		effectiveCost: cost,
		listCost: cost,
		consumedQuantity: quantity,
		tags: {},
		estimated: day >= openDay,
		...parts,
	})

	// Only days on shared infrastructure have active seconds, so a dedicated day has no overage.
	const compute = Arr.map(usage.compute, (entry) =>
		row(
			entry.day,
			{
				cloudService: "Tinybird compute",
				usageType: "vCPU overage",
				resourceId: account.accountId,
				resourceType: "organization",
				consumedUnit: "vCPU-second",
			},
			entry.overage_seconds,
			entry.overage_seconds * VCPU_OVERAGE_USD_PER_SECOND,
		),
	)

	const storage = Arr.map(usage.storage, (entry) => {
		const gigabytes = entry.bytes / GB
		return row(
			entry.day,
			{
				cloudService: "Tinybird storage",
				usageType: "Storage",
				resourceId: workspaceName(entry.workspace_id),
				resourceType: "workspace",
				consumedUnit: "GB-day",
			},
			gigabytes,
			(gigabytes * STORAGE_USD_PER_GB_MONTH) / daysInMonth(entry.day),
		)
	})

	const transfer = Arr.filterMap(usage.transfer, (entry) => {
		const gigabytes = entry.bytes / GB
		const priced =
			entry.kind === "intra"
				? { usageType: "Intra-region transfer", rate: INTRA_REGION_TRANSFER_USD_PER_GB }
				: entry.kind === "inter"
					? { usageType: "Inter-region transfer", rate: INTER_REGION_TRANSFER_USD_PER_GB }
					: null
		if (priced === null) return Result.failVoid
		return Result.succeed(
			row(
				entry.day,
				{
					cloudService: "Tinybird data transfer",
					usageType: priced.usageType,
					resourceId: workspaceName(entry.workspace_id),
					resourceType: "workspace",
					consumedUnit: "GB",
				},
				gigabytes,
				gigabytes * priced.rate,
			),
		)
	})

	const inWindow = Arr.filter(
		[...compute, ...storage, ...transfer],
		(entry) => entry.day >= window.startDay && entry.day <= window.endDay,
	)
	const groups = Arr.groupBy(inWindow, (entry) =>
		keyOf([entry.day, entry.cloudService, entry.usageType, entry.resourceId]),
	)
	const summed = Arr.map(Rec.values(groups), (group): CostPullRow => {
		const [first] = group
		const sum = (of: (entry: CostPullRow) => number) =>
			Arr.reduce(group, 0, (total, entry) => total + of(entry))
		const cost = sum((entry) => entry.billedCost)
		return {
			...first,
			billedCost: cost,
			effectiveCost: cost,
			listCost: cost,
			consumedQuantity: sum((entry) => entry.consumedQuantity),
		}
	})
	// Only nothing is left out: many sub-cent days add up to a real month.
	return Arr.filter(summed, (entry) => entry.billedCost > 0)
}
