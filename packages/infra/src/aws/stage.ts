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
 * EU prd is sized to its own (much smaller) traffic. To scale it, raise the EU
 * branches below or drop this check to inherit US sizing.
 */
function isEuPrd(stage: MapleStage, region: MapleRegion): boolean {
	return stage.kind === "prd" && region === "eu"
}

/**
 * Desired ECS task count: 2 for US prd (AZ redundancy), 1 elsewhere. The
 * gateway's per-org replay byte budget is process-local, so the effective
 * ceiling is roughly N x the configured limit.
 */
export function resolveIngestDesiredCount(stage: MapleStage, region: MapleRegion): number {
	if (isEuPrd(stage, region)) return 1
	return stage.kind === "prd" ? 2 : 1
}

/**
 * CPU target-tracking for prd ingest (US 2-6, EU 1-3); other stages stay fixed.
 * Scale-out is eager because a burst that outruns the gateway becomes edge 5xx.
 */
export interface IngestScaling {
	min: number
	max: number
	/** Target average CPU utilization, percent. */
	cpuUtilization: number
	/** Shaped like effect's `Duration.Input` so it can flow straight into alchemy. */
	scaleInCooldown: `${number} ${"seconds" | "minutes"}`
	scaleOutCooldown: `${number} ${"seconds" | "minutes"}`
}

export function resolveIngestScaling(stage: MapleStage, region: MapleRegion): IngestScaling | undefined {
	if (stage.kind !== "prd") return undefined
	const [min, max] = isEuPrd(stage, region) ? [1, 3] : [2, 6]
	return { min, max, cpuUtilization: 60, scaleInCooldown: "5 minutes", scaleOutCooldown: "60 seconds" }
}

export interface IngestTaskSize {
	/** ECS CPU units. 1024 = 1 vCPU. */
	cpu: number
	/** ECS memory in MiB. */
	memory: number
}

/**
 * `INGEST_SELF_TRACE_SAMPLE_RATIO`, or `undefined` for the default 1.0. Sampled
 * spans carry `SampleRate`, so throughput still reads true.
 */
export function resolveIngestSelfTraceSampleRatio(stage: MapleStage): string | undefined {
	return stage.kind === "prd" ? "0.05" : undefined
}

/**
 * Gateway instance type. The `d` (local NVMe instance store) holds the WAL,
 * which fsyncs every frame. `WAL_MAX_BYTES` (48 GiB, `apps/ingest/alchemy.run.ts`)
 * must fit the smallest disk: c7gd.medium has 59 GB.
 */
export function resolveIngestEc2InstanceType(stage: MapleStage, region: MapleRegion): string {
	return isEuPrd(stage, region) ? "c7gd.medium" : "c7gd.large"
}

/**
 * Gateway task size: one task per instance (host networking), leaving room for
 * a per-host daemon. Must change with `resolveIngestEc2InstanceType`.
 */
export function resolveIngestEc2TaskSize(stage: MapleStage, region: MapleRegion): IngestTaskSize {
	return isEuPrd(stage, region) ? { cpu: 1024, memory: 1536 } : { cpu: 2048, memory: 3072 }
}

/**
 * prd and PR previews deploy the gateway to AWS; dev uses docker-compose.
 * Previews answer plain HTTP on the ALB (no domain, no certificate). Must agree
 * with `PRD_LOCKSTEP_REVISION_SERVICES` in `../env.ts` (enforced by `env.test.ts`).
 */
export function stageDeploysIngest(stage: MapleStage): boolean {
	return stage.kind === "prd" || stage.kind === "pr"
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

/**
 * prd only, for cost; the intent is `stageDeploysIngest(stage)`. A preview opts
 * in with the `preview:collector` label (sets MAPLE_DEPLOY_AWS_COLLECTOR=1).
 */
export function stageDeploysCollector(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/**
 * Whether session-replay payloads go to R2 objects instead of inline in
 * `session_replay_events.Events`. The R2 endpoint is always configured, so this
 * function is the rollback lever. prd only: previews would just leave objects to reap.
 */
export function stageEnablesReplayBlobs(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/**
 * Fargate task size for the collector. Memory stays 1 GiB because the config's
 * `memory_limiter` (768 MiB) is sized for it; a limit above task memory never fires.
 */
export function resolveCollectorTaskSize(stage: MapleStage, region: MapleRegion): IngestTaskSize {
	return stage.kind === "prd" && !isEuPrd(stage, region)
		? { cpu: 512, memory: 1024 }
		: { cpu: 256, memory: 1024 }
}

/**
 * prd only: previews have no database to replicate from; dev uses the docker
 * `electric` service. Must agree with `PRD_LOCKSTEP_REVISION_SERVICES` in `../env.ts`.
 */
export function stageDeploysElectric(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/**
 * Fargate task size for Electric, sized for the BEAM's floor (low-write tables).
 * EU prd keeps the prd size: 512 MiB is unmeasured under load.
 */
export function resolveElectricTaskSize(stage: MapleStage): IngestTaskSize {
	return stage.kind === "prd" ? { cpu: 512, memory: 1024 } : { cpu: 256, memory: 512 }
}

/**
 * `ELECTRIC_DB_POOL_SIZE`, or `undefined` for the default 20. The EU cluster's
 * `max_connections=25` is shared with two Hyperdrive configs (8 each), hence 4.
 */
export function resolveElectricDbPoolSize(region: MapleRegion): number | undefined {
	return region === "eu" ? 4 : undefined
}
