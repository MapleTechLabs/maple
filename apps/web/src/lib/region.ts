import { MAPLE_REGION_LABELS, type MapleRegion, parseMapleRegion } from "@maple/domain/organization-regions"
import { Option, Schema } from "effect"

export { MAPLE_REGION_LABELS, type MapleRegion }

/** The regional instance this dashboard belongs to, stamped at build time from the deploy stage. */
export const currentRegion: MapleRegion = parseMapleRegion(import.meta.env.VITE_MAPLE_REGION)

const RegionAppUrls = Schema.fromJsonString(
	Schema.Struct({ us: Schema.optionalKey(Schema.String), eu: Schema.optionalKey(Schema.String) }),
)

const regionAppUrls: Partial<Record<MapleRegion, string>> = Option.getOrElse(
	Schema.decodeUnknownOption(RegionAppUrls)(import.meta.env.VITE_MAPLE_REGION_APP_URLS ?? ""),
	() => ({}),
)

/** The dashboard origin of `region`, when this deployment knows one. */
export function regionAppUrl(region: MapleRegion): string | undefined {
	return region === currentRegion ? window.location.origin : regionAppUrls[region]
}

/** Whether this deployment has more than one region, and so whether regions are worth showing. */
export const hasMultipleRegions = Object.keys(regionAppUrls).length > 1
