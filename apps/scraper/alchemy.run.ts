import { resolve } from "node:path"
import * as AWS from "@alchemy.run/aws"
import * as Effect from "effect/Effect"
import { ecsSecrets, resolveAwsResourceName } from "@maple/infra/aws"
import { resolveDeploymentEnvironment, type MapleStackContext } from "@maple/infra/cloudflare"
import { optionalPlain, requiredPlain } from "@maple/infra/env"

/**
 * `bun run --cwd apps/scraper bundle` writes the single-file bundle here before the deploy
 * (`alchemy:build-deps`), so the image context is one file, not the repo.
 */
const BUNDLE_CONTEXT = "apps/scraper/dist"
/** Absolute on purpose: alchemy has changed how a relative `dockerfile` resolves (docs/infra.md). */
const BUNDLE_DOCKERFILE = resolve("apps/scraper/Dockerfile.prebuilt")

/** Port of the `/health` endpoint (`PORT` in `apps/scraper/src/Env.ts`). */
const SCRAPER_PORT = 3475

export interface CreateMapleScraperOptions extends Pick<MapleStackContext, "stage" | "region" | "profile"> {
	/** The ingest VPC: a second `AWS.EC2.Network` in one stack fights over the internet gateway. */
	network: Pick<AWS.EC2.Network, "vpcId" | "publicSubnetIds">
	/** Public API origin serving `/api/internal/scrape-*`. */
	apiUrl: string
	/** Public ingest origin the scraped metrics are posted to (the ALB admits only Cloudflare). */
	ingestUrl: string
}

/**
 * The Prometheus scraper on ECS Fargate: a singleton Bun process with no inbound traffic.
 * It shares ingest's VPC and reaches the API and ingest through their public hostnames.
 */
export const createMapleScraper = ({
	stage,
	region,
	profile,
	network,
	apiUrl,
	ingestUrl,
}: CreateMapleScraperOptions) =>
	Effect.gen(function* () {
		const name = (base: string) => resolveAwsResourceName(base, stage, region)
		const tags = { Service: "maple-scraper", Region: region }

		// No ingress: the scraper only calls out. `/health` is probed from inside the task.
		const taskSecurityGroup = yield* AWS.EC2.SecurityGroup("scraper-task-sg", {
			vpcId: network.vpcId,
			groupName: name("scraper-task"),
			description: "Maple Prometheus scraper - egress only",
			ingress: [],
		})

		const cluster = yield* AWS.ECS.Cluster("scraper-cluster", {
			clusterName: name("scraper"),
			tags,
		})

		const secret = ecsSecrets(name("scraper"), tags)
		const internalToken = yield* secret("internal-token", yield* requiredPlain("SD_INTERNAL_TOKEN"))
		const otelIngestKey = yield* secret("otel-ingest-key", yield* requiredPlain("MAPLE_OTEL_INGEST_KEY"))

		const { COMMIT_SHA: commitSha, GITHUB_SHA: githubSha } = {
			...(yield* optionalPlain("COMMIT_SHA")),
			...(yield* optionalPlain("GITHUB_SHA")),
		}
		const sha = commitSha ?? githubSha

		yield* AWS.ECS.Service("scraper", {
			cluster,
			serviceName: name("scraper"),

			context: BUNDLE_CONTEXT,
			dockerfile: BUNDLE_DOCKERFILE,
			runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
			cpu: profile.scraper.taskSize.cpu,
			memory: profile.scraper.taskSize.memory,

			// Singleton: two copies would scrape every target twice. 0%/100% stops the old task
			// first, a gap of one scrape interval per deploy.
			desiredCount: 1,
			deploymentConfiguration: {
				minimumHealthyPercent: 0,
				maximumPercent: 100,
				deploymentCircuitBreaker: { enable: true, rollback: true },
			},

			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [taskSecurityGroup.groupId],
			// No NAT in the ingest VPC, so the task needs a public IP to reach anything.
			assignPublicIp: true,

			// Liveness only: any answer counts, so ECS replaces a process whose server no longer
			// responds. `/health`'s 503 means the API is unreachable, not that this task is stuck.
			// The image has no curl; bun does the probe.
			healthCheck: {
				command: [
					"CMD",
					"bun",
					"-e",
					`fetch("http://127.0.0.1:${SCRAPER_PORT}/health").then(() => process.exit(0), () => process.exit(1))`,
				],
				interval: "30 seconds",
				timeout: "5 seconds",
				retries: 3,
				startPeriod: "60 seconds",
			},

			logging: { retention: "30 days" },

			secrets: {
				SD_INTERNAL_TOKEN: internalToken.secretArn,
				MAPLE_INGEST_KEY: otelIngestKey.secretArn,
			},

			env: {
				MAPLE_API_URL: apiUrl,
				MAPLE_INGEST_URL: ingestUrl,
				PORT: String(SCRAPER_PORT),
				// Its own telemetry, to the same gateway as the scraped metrics.
				MAPLE_ENDPOINT: ingestUrl,
				MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
				OTEL_RESOURCE_ATTRIBUTES: `maple.region=${region},cloud.provider=aws`,
				...(sha ? { COMMIT_SHA: sha } : undefined),
			},

			tags,
		})
	})
