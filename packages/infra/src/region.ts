/**
 * Geographic instance, orthogonal to `MapleStage`. EU data must never transit `us`. `us` is the
 * unsuffixed default: renaming it would destroy and recreate every resource.
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

/** The suffix a region adds to physical names; empty for `us`. */
export function regionSuffix(region: MapleRegion): string {
	return region === DEFAULT_MAPLE_REGION ? "" : `-${region}`
}
