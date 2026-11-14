import * as Schema from "effect/Schema"
import { type MapleStage, resolveWorkerName } from "../cloudflare/stage.ts"
import { type AwsRegionName, DEFAULT_MAPLE_REGION, type MapleRegion, REGION_INFRA } from "../region.ts"

export type { AwsRegionName }

/** The AWS region backing a Maple region (see `REGION_INFRA`). */
export const resolveAwsRegion = (region: MapleRegion): AwsRegionName => REGION_INFRA[region].awsRegion

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
 * Cloud Map private DNS namespace, one per stage VPC (`maple-ingest.internal`).
 * Changing it replaces the namespace and every service registered in it.
 */
export function resolveIngestNamespaceName(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	return `${resolveWorkerName("ingest", stage, region)}.internal`
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
