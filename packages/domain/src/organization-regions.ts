import { Option, Schema } from "effect"

/**
 * The geographic instance an organization's data lives on. Each region is a full,
 * separate Maple deployment (`app.maple.dev`, `app.eu.maple.dev`); nothing crosses between them.
 */
export const MapleRegion = Schema.Literals(["us", "eu"])
export type MapleRegion = Schema.Schema.Type<typeof MapleRegion>

export const DEFAULT_MAPLE_REGION: MapleRegion = "us"

const decodeRegion = Schema.decodeUnknownOption(MapleRegion)

/** Parses an instance's own region setting. Anything unrecognised is the default region. */
export function parseMapleRegion(value: unknown): MapleRegion {
	return Option.getOrElse(
		decodeRegion(typeof value === "string" ? value.trim().toLowerCase() : value),
		() => DEFAULT_MAPLE_REGION,
	)
}

/**
 * An organization's regions, from the `regions` key of its Clerk public metadata.
 *
 * An array so an organization can span regions later; today every organization has exactly one.
 * Missing, malformed, or holding no known region means `["us"]`: every organization created
 * before regions existed lives on the US instance, so none needs a backfill.
 */
export function organizationRegionsFrom(metadata: unknown): readonly [MapleRegion, ...MapleRegion[]] {
	const raw =
		typeof metadata === "object" && metadata !== null && "regions" in metadata
			? metadata.regions
			: undefined
	const regions = Array.isArray(raw)
		? raw
				.flatMap((value) => Option.toArray(decodeRegion(value)))
				.filter((r, i, all) => all.indexOf(r) === i)
		: []
	const [first, ...rest] = regions
	return first === undefined ? [DEFAULT_MAPLE_REGION] : [first, ...rest]
}

/** The region an organization lives in: the first of its regions. */
export function organizationHomeRegion(metadata: unknown): MapleRegion {
	return organizationRegionsFrom(metadata)[0]
}

/** Whether an organization may be served by the instance running in `region`. */
export function organizationServedIn(metadata: unknown, region: MapleRegion): boolean {
	return organizationRegionsFrom(metadata).includes(region)
}

/** The Clerk public metadata an organization created in `region` starts with. */
export function organizationRegionMetadata(region: MapleRegion): {
	readonly regions: readonly MapleRegion[]
} {
	return { regions: [region] }
}

export const MAPLE_REGION_LABELS = {
	us: { short: "US", name: "United States" },
	eu: { short: "EU", name: "European Union (Frankfurt)" },
} as const satisfies Record<MapleRegion, { readonly short: string; readonly name: string }>
