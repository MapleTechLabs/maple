import type { RegionName } from "@distilled.cloud/aws/Region"
import type { MapleStage } from "../cloudflare/stage.ts"
import { DEFAULT_MAPLE_REGION, type MapleRegion, regionSuffix } from "../region.ts"

// The region itself lives in `../region.ts`, shared with the Cloudflare half;
// re-exported here so existing `@maple/infra/aws` imports keep resolving.
export * from "../region.ts"

/**
 * The AWS regions Maple deploys into, as the literal union the AWS client
 * types use. Narrower than `string` on purpose: it is what lets a region flow
 * into an AWS `Region` override without a cast at the call site.
 */
export type AwsRegionName = Extract<RegionName, "us-east-1" | "eu-central-1">

/**
 * AWS region backing each Maple region.
 *
 * This MUST match the region of the Tinybird workspace the instance exports to.
 * AWS bills $0.09/GB to the public internet but only $0.01/GB to a public IP in
 * the SAME region, and the gateway's export traffic dwarfs every other line
 * item — at 200k req/s that difference is ~$83k/mo vs ~$16k/mo. Tinybird's AWS
 * regions are us-east-1, us-west-2, eu-central-1, eu-west-1, ap-east-1,
 * ap-southeast-2; a workspace on `https://api.tinybird.co` is GCP Frankfurt, in
 * which case NO AWS region colocates and the move costs more than Railway.
 *
 * Verify the instance's TINYBIRD_HOST before changing a mapping.
 */
export function resolveAwsRegion(region: MapleRegion): AwsRegionName {
	switch (region) {
		case "us":
			return "us-east-1"
		case "eu":
			return "eu-central-1"
	}
}

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
 * Physical name for an AWS resource, mirroring `resolveWorkerName` so both
 * clouds read the same in a console. Kept as a separate function rather than
 * reusing the Cloudflare one because AWS name constraints differ per service
 * (ECS names allow `[a-zA-Z0-9-_]`, but ALB names cap at 32 chars).
 *
 * `us` carries no region suffix — see `MapleRegion`.
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
 * Desired ECS task count per stage.
 *
 * prd runs 2 for availability across AZs; everything else runs 1. Note the
 * per-org replay byte budget in the gateway is process-local
 * (`apps/ingest/src/main.rs`), so the effective ceiling is roughly N x the
 * configured limit — raising this raises that ceiling too.
 */
export function resolveIngestDesiredCount(stage: MapleStage): number {
	return stage.kind === "prd" ? 2 : 1
}

/**
 * Target-tracking autoscaling for the ingest service, or `undefined` for a
 * fixed desired count.
 *
 * prd: 2–6 tasks on 60% average CPU. The floor is today's fixed count (AZ
 * redundancy); the ceiling is ~6x current traffic at ~1,300 req/s per vCPU.
 * Scale-out is eager (1 min) because a burst that outruns the gateway turns
 * into 5xx at the edge; scale-in is lazy (5 min) so a lull does not thrash.
 * Note the per-org replay byte budget is process-local, so the effective
 * ceiling scales with the task count (see `resolveIngestDesiredCount`).
 * Other stages stay fixed: nothing bursts at a preview.
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

export function resolveIngestScaling(stage: MapleStage): IngestScaling | undefined {
	return stage.kind === "prd"
		? { min: 2, max: 6, cpuUtilization: 60, scaleInCooldown: "5 minutes", scaleOutCooldown: "60 seconds" }
		: undefined
}

export interface IngestTaskSize {
	/** Fargate CPU units. 1024 = 1 vCPU. */
	cpu: number
	/** Fargate memory in MiB. Must be a legal pairing with `cpu`. */
	memory: number
}

/**
 * Fargate task size per stage.
 *
 * Sized from ~1,300 req/s per vCPU — gzip level 6 on the export path
 * (`apps/ingest/src/telemetry.rs`) is the binding constraint, not protobuf
 * decode. prd gets 1 vCPU x 2 tasks, which carries today's ~500 req/s with
 * roughly 4x headroom for bursts.
 */
export function resolveIngestTaskSize(stage: MapleStage): IngestTaskSize {
	return stage.kind === "prd" ? { cpu: 1024, memory: 2048 } : { cpu: 512, memory: 1024 }
}

/**
 * Which fleets run the gateway. Both can run at once, each behind its own ALB,
 * which is how a fleet cutover works: bring the new one up beside the old,
 * flip the proxied `ingest` CNAME, then drop the old one.
 */
export interface IngestFleets {
	fargate: boolean
	ec2: boolean
}

/**
 * Parses `MAPLE_INGEST_FLEETS` (`fargate`, `ec2`, or `fargate,ec2`). Unset is
 * EC2 only, where prd has run since the 2026-09-21 cutover; the variable is
 * only set to bring Fargate back beside it.
 */
export function parseIngestFleets(value: string | undefined): IngestFleets {
	const requested = (value ?? "")
		.split(",")
		.map((fleet) => fleet.trim())
		.filter((fleet) => fleet !== "")
	if (requested.length === 0) return { fargate: false, ec2: true }
	const unknown = requested.filter((fleet) => fleet !== "fargate" && fleet !== "ec2")
	if (unknown.length > 0) {
		throw new Error(
			`MAPLE_INGEST_FLEETS: unknown fleet(s) "${unknown.join(", ")}" (expected fargate, ec2)`,
		)
	}
	return { fargate: requested.includes("fargate"), ec2: requested.includes("ec2") }
}

/**
 * EC2 instance type for the gateway: Graviton3 with a 118 GB local NVMe
 * instance store, which holds the WAL. The `d` is the point: the WAL fsyncs
 * every frame, and instance-store fsync is tens of microseconds where Fargate's
 * network-backed ephemeral storage is milliseconds.
 */
export const INGEST_EC2_INSTANCE_TYPE = "c7gd.large"

/**
 * Task size on the EC2 fleet, every stage. One task per instance (host
 * networking binds the port), so it claims the c7gd.large's 2 vCPU and most of
 * its ~3.7 GiB registered memory, leaving room for a per-host monitoring daemon.
 */
export const INGEST_EC2_TASK_SIZE: IngestTaskSize = { cpu: 2048, memory: 3072 }

/**
 * Whether a stage gets an AWS ingest deployment at all.
 *
 * Every deployed stage does — prd and PR previews. Dev stages run the gateway
 * through docker-compose instead and never reach AWS.
 *
 * A VPC + ALB + ECS cluster per preview is real money, so the spend gate is not
 * here: previews only deploy at all when the PR carries the `preview` label
 * (`.github/workflows/deploy-pr-preview.yml`), and the whole stack is torn down
 * when the label comes off or the PR closes. A preview gets no `ingest` domain
 * from `resolveMapleDomains`, so its ALB answers plain HTTP on 80 with no ACM
 * certificate — point an OTLP exporter at `http://<alb>/v1/traces`.
 *
 * Changing this for prd also breaks the prd revision lockstep — see
 * `PRD_LOCKSTEP_REVISION_SERVICES` in `../env.ts`, which the "Prod revision
 * skew" alert rule depends on. `env.test.ts` fails if the two disagree.
 */
export function stageDeploysIngest(stage: MapleStage): boolean {
	return stage.kind === "prd" || stage.kind === "pr"
}

/**
 * Cloud Map private DNS namespace the ingest fleet's internal services live
 * in — one per stage VPC (`maple-ingest.internal`,
 * `maple-ingest-pr-12.internal`, …). `.internal` is the TLD ICANN reserved for
 * exactly this. The name follows
 * `resolveAwsResourceName` so the two read the same in a console; changing it
 * replaces the namespace and every service registered in it.
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
 * The gateway's `INGEST_FORWARD_OTLP_ENDPOINT` on AWS: the in-VPC collector,
 * by its Cloud Map name. A plain string at plan time — both halves of the
 * hostname are chosen here, not generated by AWS — so it can be fed into the
 * gateway's task env without an alchemy Output.
 */
export function resolveCollectorEndpoint(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	return `http://${COLLECTOR_DNS_LABEL}.${resolveIngestNamespaceName(stage, region)}:${COLLECTOR_OTLP_HTTP_PORT}`
}

/**
 * Whether a stage gets the OTel collector beside its gateway.
 *
 * prd only for now — a cash-flow call, not a design one. The intent is every
 * stage that deploys the gateway (`stageDeploysIngest`), so previews carry
 * their own self-telemetry too; flip this to `stageDeploysIngest(stage)`
 * when the budget allows (~$13.5/mo per stage at the non-prd size). Until
 * then a preview can opt in by also carrying the `preview:collector` label,
 * which sets MAPLE_DEPLOY_AWS_COLLECTOR=1 for that deploy — this is how the
 * collector was verified on Fargate before it reached prod.
 */
export function stageDeploysCollector(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/**
 * Whether this stage stores session-replay rrweb payloads as R2 objects
 * instead of inline in the `session_replay_events.Events` column.
 *
 * This is an EXPLICIT gate rather than the older "is INGEST_REPLAY_R2_ENDPOINT
 * set?" test. Once the stack mints the R2 credentials itself (a bucket-scoped
 * `AccountApiToken`, see the root stack) the endpoint is always available, so
 * config presence stops being able to express intent — and with it went the
 * only rollback lever, which was "unset the secret and redeploy". Flipping this
 * function is now that lever.
 *
 * prd only, which is where it has run since staging was removed — staging was
 * the other stage on this gate, and the argument for it was that production
 * should not be the first place the write path ever runs. Previews stay off: a
 * PR preview writing real objects into its own bucket buys nothing and leaves
 * more to reap.
 */
export function stageEnablesReplayBlobs(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/**
 * Fargate task size for the collector per stage.
 *
 * In `tinybird` write mode (prod) the collector only carries the gateway's own
 * telemetry, which is a rounding error; prd gets half a vCPU so a switch to
 * `dual`/`forward` mode has headroom before the next deploy. Memory is 1 GiB
 * everywhere because the config's `memory_limiter` (768 MiB hard, 192 MiB
 * spike) is sized for it — a limit above task memory never fires.
 */
export function resolveCollectorTaskSize(stage: MapleStage): IngestTaskSize {
	return stage.kind === "prd" ? { cpu: 512, memory: 1024 } : { cpu: 256, memory: 1024 }
}

/**
 * Whether a stage runs its own ElectricSQL sync service.
 *
 * PR previews are excluded for the same reason they get no Electric config at
 * all: no PlanetScale branch, so nothing to replicate from. Dev stages use the
 * docker `electric` service.
 *
 * Changing this for prd also breaks the prd revision lockstep — see
 * `PRD_LOCKSTEP_REVISION_SERVICES` in `../env.ts`, which the "Prod revision
 * skew" alert rule depends on. `env.test.ts` fails if the two disagree.
 */
export function stageDeploysElectric(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/**
 * Fargate task size for Electric per stage.
 *
 * Eight low-write control-plane tables, so this is sized for the BEAM's floor
 * rather than for throughput. Raise it when a shape's snapshot query, not its
 * change stream, becomes the cost.
 */
export function resolveElectricTaskSize(stage: MapleStage): IngestTaskSize {
	return stage.kind === "prd" ? { cpu: 512, memory: 1024 } : { cpu: 256, memory: 512 }
}
