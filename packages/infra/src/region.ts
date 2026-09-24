/**
 * Geographic instance a deployment belongs to.
 *
 * Orthogonal to `MapleStage`: stage is prd/pr/dev, region is which
 * geographic instance. A full EU instance is `region: "eu"` at every stage,
 * with its OWN Tinybird workspace, application database, ingest fleet and
 * Worker set under `*.eu.maple.dev` — telemetry that lands in `eu` must never
 * transit `us`, which is the whole point of having one. There is no per-org
 * routing anywhere: an org's region is the instance it was created on.
 *
 * `us` is deliberately the unsuffixed default so adding `eu` renames nothing
 * (a rename destroys and recreates every resource).
 *
 * Lives outside `aws/` and `cloudflare/` because both halves of the stack key
 * on it and each imports the other's stage module.
 */
export type MapleRegion = "us" | "eu"

export const MAPLE_REGIONS: ReadonlyArray<MapleRegion> = ["us", "eu"]

export const DEFAULT_MAPLE_REGION: MapleRegion = "us"

export function isMapleRegion(value: string): value is MapleRegion {
	return value === "us" || value === "eu"
}

export function parseMapleRegion(value: string | undefined): MapleRegion {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) {
		return DEFAULT_MAPLE_REGION
	}
	if (isMapleRegion(normalized)) {
		return normalized
	}
	throw new Error(`Unsupported Maple region "${value}". Expected "us" or "eu".`)
}

/**
 * The suffix a region contributes to a physical name — Worker, bucket, ECS
 * service, Cloud Map namespace. Empty for `us`, see {@link MapleRegion}.
 */
export function regionSuffix(region: MapleRegion): string {
	return region === DEFAULT_MAPLE_REGION ? "" : `-${region}`
}
