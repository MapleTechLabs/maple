import type { RegionName } from "@distilled.cloud/aws/Region"
import { DEFAULT_MAPLE_REGION, MapleRegion } from "@maple/domain/organization-regions"
import * as Schema from "effect/Schema"

export { DEFAULT_MAPLE_REGION, MapleRegion }

/** Every geographic instance. `us` is unsuffixed: renaming it would recreate every resource. */
export const MAPLE_REGIONS = MapleRegion.literals

export const isMapleRegion = Schema.is(MapleRegion)

/** The suffix a region adds to physical names; empty for `us`. */
export function regionSuffix(region: MapleRegion): string {
	return region === DEFAULT_MAPLE_REGION ? "" : `-${region}`
}

/** AWS regions Maple deploys into, narrowed so they flow into a `Region` override without a cast. */
export type AwsRegionName = Extract<RegionName, "us-east-1" | "eu-central-1">

interface RegionInfra {
	/**
	 * MUST match the region of the Tinybird workspace the instance exports to: same-region egress
	 * is $0.01/GB vs $0.09/GB, and export is the dominant cost. Check TINYBIRD_HOST first.
	 */
	readonly awsRegion: AwsRegionName
	/** Ingest VPC CIDR, non-overlapping so two instances can be peered later without renumbering. */
	readonly ingestCidrBlock: string
	/** R2 / Durable Object jurisdiction (a hard guarantee); fixed when a bucket is created. */
	readonly storageJurisdiction: "eu" | undefined
}

/** Everything about the infrastructure that differs per region, other than names and hostnames. */
export const REGION_INFRA = {
	us: { awsRegion: "us-east-1", ingestCidrBlock: "10.20.0.0/16", storageJurisdiction: undefined },
	eu: { awsRegion: "eu-central-1", ingestCidrBlock: "10.21.0.0/16", storageJurisdiction: "eu" },
} satisfies Record<MapleRegion, RegionInfra>
