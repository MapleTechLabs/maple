import type { RegionName } from "@distilled.cloud/aws/Region"
import * as Schema from "effect/Schema"
import type { MapleStage } from "../cloudflare/stage.ts"
import { DEFAULT_MAPLE_REGION, type MapleRegion, regionSuffix } from "../region.ts"

// Re-exported so `@maple/infra/aws` imports keep resolving.
export * from "../region.ts"

/** AWS regions Maple deploys into, narrowed so they flow into a `Region` override without a cast. */
export type AwsRegionName = Extract<RegionName, "us-east-1" | "eu-central-1">

/**
 * AWS region backing each Maple region. MUST match the region of the Tinybird
 * workspace the instance exports to: same-region egress is $0.01/GB vs $0.09/GB,
 * and export is the dominant cost. Check the instance's TINYBIRD_HOST first.
 */
export function resolveAwsRegion(region: MapleRegion): AwsRegionName {
	switch (region) {
		case "us":
			return "us-east-1"
		case "eu":
			return "eu-central-1"
	}
}

/** The deploy's `AWS_REGION` is not the region its Maple instance runs in. */
export class AwsRegionMismatchError extends Schema.TaggedError<AwsRegionMismatchError>()(
	"@maple/infra/AwsRegionMismatchError",
	{
		message: Schema.String,
		awsRegion: Schema.String,
		mapleRegion: Schema.String,
		expectedAwsRegion: Schema.String,
	},
) {}

/**
 * VPC CIDR per Maple region, kept non-overlapping so two instances can be
 * peered later without renumbering. Nothing peers them today.
 */
export function resolveIngestCidrBlock(region: MapleRegion): string {
	switch (region) {
		case "us":
			return "10.20.0.0/16"
		case "eu":
			return "10.21.0.0/16"
	}
}

/**
 * Physical name for an AWS resource, mirroring `resolveWorkerName`. Separate
 * because AWS name limits differ per service (ALB names cap at 32 chars).
 * `us` carries no region suffix.
 */
export function resolveAwsResourceName(
	base: string,
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	const suffix = regionSuffix(region)
	switch (stage.kind) {
		case "prd":
			return `maple-${base}${suffix}`
		case "pr":
			return `maple-${base}${suffix}-pr-${stage.prNumber}`
		case "dev":
			return `maple-${base}${suffix}-dev-${stage.name}`
	}
}

/**
 * Cloud Map private DNS namespace, one per stage VPC (`maple-ingest.internal`).
 * Changing it replaces the namespace and every service registered in it.
 */
export function resolveIngestNamespaceName(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	return `${resolveAwsResourceName("ingest", stage, region)}.internal`
}

/** DNS label of the collector's Cloud Map service inside the ingest namespace. */
export const COLLECTOR_DNS_LABEL = "otel-collector"

/** OTLP/HTTP receiver port of the collector (`packages/infra/otel-collector/collector-config.yaml`). */
export const COLLECTOR_OTLP_HTTP_PORT = 4318

/**
 * The gateway's `INGEST_FORWARD_OTLP_ENDPOINT`: the in-VPC collector by Cloud
 * Map name. A plain string at plan time, so it needs no alchemy Output.
 */
export function resolveCollectorEndpoint(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	return `http://${COLLECTOR_DNS_LABEL}.${resolveIngestNamespaceName(stage, region)}:${COLLECTOR_OTLP_HTTP_PORT}`
}
