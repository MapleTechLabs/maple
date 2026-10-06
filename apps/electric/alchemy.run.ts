import { resolve } from "node:path"
import * as AWS from "alchemy/AWS"
import type * as Output from "alchemy/Output"
import type * as Planetscale from "alchemy/Planetscale"
import * as Effect from "effect/Effect"
import { ecsSecrets, pgUrlRequireSsl, resolveAwsRegion, resolveAwsResourceName } from "@maple/infra/aws"
import { issueRegionalCertificate, publishProxiedCname } from "@maple/infra/acm"
import type { MapleStackContext } from "@maple/infra/cloudflare"
import { requiredPlain } from "@maple/infra/env"

/** Port Electric's HTTP API binds (`ELECTRIC_PORT`, whose own default is 3000). */
const ELECTRIC_PORT = 3000

/** Absolute: alchemy has changed how a relative `dockerfile` resolves between releases. */
const DOCKERFILE = resolve("apps/electric/Dockerfile")

export interface CreateMapleElectricOptions extends Pick<
	MapleStackContext,
	"stage" | "region" | "domains" | "profile"
> {
	/** The ingest VPC: a second `AWS.EC2.Network` in one stack fights over the internet gateway. */
	network: Pick<AWS.EC2.Network, "vpcId" | "publicSubnetIds">
	/** The replication role on the instance's branch (`withReplication`), minted by the root. */
	dbRole: Planetscale.PostgresRole
}

/**
 * Self-hosted ElectricSQL on ECS Fargate, the upstream behind `apps/electric-sync`.
 * Shares ingest's VPC but has its own cluster, ALB, security groups and certificate.
 * Runbook: `docs/electric-sync.md`.
 */
export const createMapleElectric = ({
	stage,
	region,
	domains,
	profile,
	network,
	dbRole,
}: CreateMapleElectricOptions) =>
	Effect.gen(function* () {
		const { taskSize, dbPoolSize } = profile.electric
		const name = (base: string) => resolveAwsResourceName(base, stage, region)
		const tags = { Service: "maple-electric", Region: region }

		// Alchemy keys state by logical id: renaming these ids replaces live groups, and a
		// new group must also get a new `groupName` or it collides with the old one.
		// `securityGroups` apply to both ALB and tasks, so only the ALB's group may reach
		// ELECTRIC_PORT; otherwise a task's public IP serves plaintext around the cert.
		const listenerPort = domains.electric ? 443 : 80
		const albSecurityGroup = yield* AWS.EC2.SecurityGroup("electric-lb-sg", {
			vpcId: network.vpcId,
			groupName: name("electric-lb"),
			description: `Maple ElectricSQL - public ${listenerPort === 443 ? "HTTPS" : "HTTP"} to the load balancer`,
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: listenerPort,
					toPort: listenerPort,
					// Not narrowed to Cloudflare ranges (they rotate); ELECTRIC_SECRET authorizes.
					cidrIpv4: "0.0.0.0/0",
					description: "Shape requests from the electric-sync Worker",
				},
			],
		})

		const taskSecurityGroup = yield* AWS.EC2.SecurityGroup("electric-task-sg", {
			vpcId: network.vpcId,
			groupName: name("electric-task"),
			description: "Maple ElectricSQL sync service",
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: ELECTRIC_PORT,
					toPort: ELECTRIC_PORT,
					referencedGroupId: albSecurityGroup.groupId,
					description: "ALB to task",
				},
			],
		})

		const cluster = yield* AWS.ECS.Cluster("electric-cluster", {
			clusterName: name("electric"),
			tags,
		})

		const secret = ecsSecrets(name("electric"), tags)

		// Direct connection (5432), never a pooler: logical replication needs it. The role
		// must carry the REPLICATION attribute itself (membership does not grant it).
		const databaseUrl = yield* secret("database-url", pgUrlRequireSsl(dbRole.connectionUrl))
		// Shared with the electric-sync Worker; rotate by redeploying this first, then the Worker.
		const apiSecret = yield* secret("api-secret", yield* requiredPlain("ELECTRIC_SECRET"))

		const issuedCertificateArn = yield* issueRegionalCertificate({
			id: "electric-cert",
			hostname: domains.electric,
			region: resolveAwsRegion(region),
			tags,
		})

		const baseEnv = {
			ELECTRIC_PORT: String(ELECTRIC_PORT),
			// A replaced role restarts the task on the new secret before the old role is deleted.
			MAPLE_PG_ROLE_ID: dbRole.id,
			// A Drizzle migration owns `electric_publication_default` (Electric cannot own
			// tables on PlanetScale); the stream id stays `default` to match it.
			ELECTRIC_MANUAL_TABLE_PUBLISHING: "true",
			// ELECTRIC_STORAGE_DIR stays task-local: losing it costs only a re-snapshot,
			// while EFS is discouraged and EBS pins one AZ.
		} satisfies Record<string, string | Output.Output<string>>
		const env =
			dbPoolSize === undefined ? baseEnv : { ...baseEnv, ELECTRIC_DB_POOL_SIZE: String(dbPoolSize) }

		const service = yield* AWS.ECS.Service("electric", {
			cluster,
			serviceName: name("electric"),

			context: "apps/electric",
			dockerfile: DOCKERFILE,
			// Must match the image arch: a mismatch dies at start with `exec format error`.
			runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
			cpu: taskSize.cpu,
			memory: taskSize.memory,

			// Singleton: two tasks cannot share a replication slot, so 0%/100% stops the old
			// task first (~60s of failed shapes per deploy, docs/electric-sync.md).
			desiredCount: 1,
			deploymentConfiguration: {
				minimumHealthyPercent: 0,
				maximumPercent: 100,
				deploymentCircuitBreaker: { enable: true, rollback: true },
			},

			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [albSecurityGroup.groupId, taskSecurityGroup.groupId],
			assignPublicIp: true,

			// Public: the caller is a Worker with no route into the VPC; ELECTRIC_SECRET guards it.
			// `port` is the container port; the listener goes to 443 once `certificateArn` is set.
			public: true,
			port: ELECTRIC_PORT,
			healthCheckPath: "/v1/health",
			...(issuedCertificateArn ? { certificateArn: issuedCertificateArn } : undefined),
			// Covers the replication connect and a cold task's first snapshot.
			healthCheckGracePeriod: "120 seconds",

			logging: { retention: "30 days" },

			secrets: {
				DATABASE_URL: databaseUrl.secretArn,
				ELECTRIC_SECRET: apiSecret.secretArn,
			},

			env,

			tags,
		})

		// The public name, proxied through Cloudflare to the ALB.
		if (domains.electric) {
			yield* publishProxiedCname({
				id: "electric-public-cname",
				hostname: domains.electric,
				serviceUrl: service.url,
			})
		}

		return { serviceUrl: service.url }
	})
