import { DEFAULT_MAPLE_REGION } from "./region.ts"
import type { MapleDeployment } from "./cloudflare/stage.ts"

/**
 * How a deployment reaches the app database: `ref` (dashboard Hyperdrive by id, US prd),
 * `declared` (deploy-declared roles and configs, EU prd), `managed` (from `MAPLE_PG_URL`, dev),
 * `preview` (a Neon branch per PR, migrated by its deploy). See docs/infra.md.
 */
export type MapleDatabaseMode = "ref" | "declared" | "managed" | "preview"

/**
 * The AWS account security baseline (`@maple/infra/security-baseline`). `regional` is AWS Config
 * and GuardDuty in the instance's region; `account` adds the account's one multi-region trail.
 */
export type AwsSecurityBaseline = "none" | "regional" | "account"

export interface TaskSize {
	/** ECS CPU units. 1024 = 1 vCPU. */
	readonly cpu: number
	/** ECS memory in MiB. */
	readonly memory: number
}

/** Target-tracking autoscaling for the ingest service. Shaped to flow straight into alchemy. */
export interface IngestScaling {
	readonly min: number
	readonly max: number
	/** Target average CPU utilization, percent. */
	readonly cpuUtilization: number
	readonly scaleInCooldown: `${number} ${"seconds" | "minutes"}`
	readonly scaleOutCooldown: `${number} ${"seconds" | "minutes"}`
}

/** Everything that differs between deployments, other than names and hostnames. */
export interface MapleProfile {
	readonly database: MapleDatabaseMode
	/** Whether the deploy declares its database branch (PlanetScale on prd, Neon on previews) and migrates it. */
	readonly migratesDatabase: boolean
	/** Which optional parts of the stack this deployment runs. */
	readonly deploys: {
		/** Landing and local-ui are shared across instances: `us` only. */
		readonly sharedApps: boolean
		/** The OTLP gateway on AWS. Dev runs it through docker-compose. */
		readonly ingest: boolean
		/** The OTel collector beside the gateway (`MAPLE_DEPLOY_AWS_COLLECTOR=1` forces it for one deploy). */
		readonly collector: boolean
		/** Self-hosted Electric. Needs a declared database to replicate from, so not on dev. */
		readonly electric: boolean
		/** The Prometheus scraper on Fargate, in ingest's VPC. One per instance that scrapes. */
		readonly scraper: boolean
		/** The agents' repository sandbox. Dev would pull the multi-gigabyte image. */
		readonly sandbox: boolean
		/** Session-replay payloads as R2 objects instead of inline. Flipping this is the rollback lever. */
		readonly replayBlobs: boolean
		/** prd only: previews and dev share the AWS account and must not own its audit controls. */
		readonly awsSecurityBaseline: AwsSecurityBaseline
		/** Maple's IAM user for the AWS integration. Dev uses the shared dev user from `.env.local`. */
		readonly awsIntegrationPrincipal: boolean
	}
	readonly ingest: {
		/** The per-org replay byte budget is process-local, so it scales with this. */
		readonly desiredCount: number
		/** `undefined` keeps a fixed count. */
		readonly scaling: IngestScaling | undefined
		/** Graviton with local NVMe for the WAL; the 48 GiB WAL cap must fit the smallest disk. */
		readonly instanceType: "c7gd.large" | "c7gd.medium"
		/** One task per host: claims the host's vCPU and most of its memory. Change with `instanceType`. */
		readonly taskSize: TaskSize
		/** 1 GiB everywhere: the collector config's `memory_limiter` is sized for it. */
		readonly collectorTaskSize: TaskSize
		/** Head-sampling of the gateway's own traces, or `undefined` for the default 1.0. */
		readonly selfTraceSampleRatio: string | undefined
	}
	readonly scraper: {
		readonly taskSize: TaskSize
	}
	readonly electric: {
		readonly taskSize: TaskSize
		/** `ELECTRIC_DB_POOL_SIZE`, or `undefined` for Electric's default of 20. */
		readonly dbPoolSize: number | undefined
	}
}

const scaling = (min: number, max: number): IngestScaling => ({
	min,
	max,
	cpuUtilization: 60,
	scaleInCooldown: "5 minutes",
	scaleOutCooldown: "60 seconds",
})

/** US prd: sized from ~1,300 req/s per vCPU, with AZ redundancy. */
const US_PRD: MapleProfile = {
	database: "ref",
	migratesDatabase: true,
	deploys: {
		sharedApps: true,
		ingest: true,
		collector: true,
		electric: true,
		scraper: true,
		sandbox: true,
		replayBlobs: true,
		awsSecurityBaseline: "account",
		awsIntegrationPrincipal: true,
	},
	ingest: {
		desiredCount: 2,
		scaling: scaling(2, 6),
		instanceType: "c7gd.large",
		taskSize: { cpu: 2048, memory: 3072 },
		collectorTaskSize: { cpu: 512, memory: 1024 },
		selfTraceSampleRatio: "0.05",
	},
	electric: { taskSize: { cpu: 512, memory: 1024 }, dbPoolSize: undefined },
	scraper: { taskSize: { cpu: 512, memory: 1024 } },
}

/**
 * EU prd: sized to its own traffic (a fraction of the US). Its cluster runs at
 * `max_connections=25`, shared with two Hyperdrive configs, hence Electric's pool of 4.
 */
const EU_PRD: MapleProfile = {
	...US_PRD,
	database: "declared",
	// No scraper until `prod-eu` carries its own SD_INTERNAL_TOKEN (docs/eu-region-plan.md).
	deploys: { ...US_PRD.deploys, sharedApps: false, scraper: false, awsSecurityBaseline: "regional" },
	ingest: {
		desiredCount: 1,
		scaling: scaling(1, 3),
		instanceType: "c7gd.medium",
		taskSize: { cpu: 1024, memory: 1536 },
		collectorTaskSize: { cpu: 256, memory: 1024 },
		selfTraceSampleRatio: "0.05",
	},
	electric: { taskSize: { cpu: 512, memory: 1024 }, dbPoolSize: 4 },
}

/** Non-prd sizing; a preview or dev stage never bursts. */
const SMALL_INGEST: MapleProfile["ingest"] = {
	desiredCount: 1,
	scaling: undefined,
	instanceType: "c7gd.large",
	taskSize: { cpu: 2048, memory: 3072 },
	collectorTaskSize: { cpu: 256, memory: 1024 },
	selfTraceSampleRatio: undefined,
}

/** PR previews: the whole stack on a Neon branch of their own, minus the sandbox. */
const PR: MapleProfile = {
	database: "preview",
	migratesDatabase: true,
	deploys: {
		sharedApps: true,
		ingest: true,
		collector: false,
		electric: true,
		// A preview's scrape targets are tested with a local scraper (`bun dev scraper`).
		scraper: false,
		sandbox: false,
		replayBlobs: false,
		awsSecurityBaseline: "none",
		awsIntegrationPrincipal: true,
	},
	ingest: SMALL_INGEST,
	electric: { taskSize: { cpu: 256, memory: 512 }, dbPoolSize: undefined },
	scraper: { taskSize: { cpu: 256, memory: 512 } },
}

/** `preview:web` PRs: the Workers on their own Neon and Tinybird branches; on AWS, only an IAM user. */
const PR_WEB: MapleProfile = {
	...PR,
	deploys: { ...PR.deploys, sharedApps: false, ingest: false, electric: false },
}

/** Dev stages: Workers on alchemy's local runtime; everything else runs in docker-compose. */
const DEV: MapleProfile = {
	...PR,
	database: "managed",
	migratesDatabase: false,
	deploys: { ...PR.deploys, ingest: false, electric: false, awsIntegrationPrincipal: false },
}

export interface MapleProfileOptions {
	/** A PR stage deployed from the `preview:web` label (`MAPLE_PREVIEW_WEB_ONLY=1`). */
	readonly webOnlyPreview?: boolean
}

/** The profile for one deployment. PR previews are `us` only (`parseMapleDeployment`). */
export function resolveMapleProfile(
	{ stage, region }: MapleDeployment,
	{ webOnlyPreview = false }: MapleProfileOptions = {},
): MapleProfile {
	const shared = region === DEFAULT_MAPLE_REGION
	switch (stage.kind) {
		case "prd":
			return shared ? US_PRD : EU_PRD
		case "pr":
			return webOnlyPreview ? PR_WEB : PR
		case "dev":
			return shared
				? DEV
				: {
						...DEV,
						deploys: { ...DEV.deploys, sharedApps: false },
						electric: { ...DEV.electric, dbPoolSize: 4 },
					}
	}
}
