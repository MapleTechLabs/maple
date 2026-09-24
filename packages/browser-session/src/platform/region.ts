// Maple's hosted regions, shared by the browser SDK and every Effect SDK preset.
// Pure: no browser globals, so the server and Workers entrypoints can bundle it.

/** A Maple hosting region. Each is a separate instance with its own ingest keys. */
export type MapleRegion = "us" | "eu"

export const MAPLE_REGIONS: ReadonlyArray<MapleRegion> = ["us", "eu"]

/** The region an SDK uses when neither an endpoint nor a region is configured. */
export const DEFAULT_MAPLE_REGION: MapleRegion = "us"

const INGEST_ENDPOINTS = {
	us: "https://ingest.maple.dev",
	eu: "https://ingest.eu.maple.dev",
} satisfies Record<MapleRegion, string>

/**
 * Narrow an untyped region (an env var, or a JS caller outside the type
 * checker) to a known one. Case and surrounding whitespace are ignored;
 * anything else is `undefined`.
 */
export function parseRegion(raw: unknown): MapleRegion | undefined {
	if (typeof raw !== "string") return undefined
	const value = raw.trim().toLowerCase()
	return MAPLE_REGIONS.find((region) => region === value)
}

let warnedRegions = new Set<string>()

/** Test seam: clears the one-warning-per-value memory. */
export function resetRegionWarningsForTests(): void {
	warnedRegions = new Set()
}

/**
 * The ingest base URL for a region. An unrecognized value falls back to the
 * default region with a console warning rather than throwing: the ingest key
 * belongs to one instance, so the other one rejects it and no data lands in
 * the wrong place.
 */
export function ingestEndpointForRegion(region: unknown): string {
	if (region === undefined || region === null || region === "") {
		return INGEST_ENDPOINTS[DEFAULT_MAPLE_REGION]
	}
	const parsed = parseRegion(region)
	if (parsed) return INGEST_ENDPOINTS[parsed]
	const label = String(region)
	if (!warnedRegions.has(label)) {
		warnedRegions.add(label)
		console.warn(
			`[maple] unknown region "${label}"; expected one of ${MAPLE_REGIONS.join(", ")}. Using "${DEFAULT_MAPLE_REGION}".`,
		)
	}
	return INGEST_ENDPOINTS[DEFAULT_MAPLE_REGION]
}

/**
 * Resolve the ingest base URL. An explicit URL always beats a region, whichever
 * source each came from, so a collector or proxy endpoint is never bypassed by
 * a region set elsewhere. Candidates are tried in order; the first non-empty
 * one wins.
 */
export function resolveIngestEndpoint(options: {
	readonly endpoints: ReadonlyArray<string | undefined>
	readonly regions: ReadonlyArray<unknown>
}): string {
	for (const endpoint of options.endpoints) {
		if (endpoint) return endpoint.replace(/\/+$/, "")
	}
	const region = options.regions.find((value) => value !== undefined && value !== null && value !== "")
	return ingestEndpointForRegion(region)
}
