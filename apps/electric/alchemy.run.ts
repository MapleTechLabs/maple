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

export interface CreateMapleElectricOptions extends Pick<MapleStackContext, "stage" | "region" | "profile"> {
	/** The ingest VPC: a second `AWS.EC2.Network` in one stack fights over the internet gateway. */
	network: Pick<AWS.EC2.Network, "vpcId" | "publicSubnetIds">
	/** Ingest's ALB listener, shared: a dedicated ALB costs more than this service's traffic. */
	listener: AWS.ELBv2.Listener
	/** The shared ALB's group, the only source admitted to ELECTRIC_PORT. */
	albSecurityGroupId: AWS.EC2.SecurityGroup["groupId"]
	/** Routed by host on the shared listener, so required (prd is the only stage that deploys this). */
	hostname: string
	/** The replication role on the instance's branch (`withReplication`), minted by the root. */
	dbRole: Planetscale.PostgresRole
}

/**
 * Self-hosted ElectricSQL on ECS Fargate, the upstream behind `apps/electric-sync`.
 * Shares ingest's VPC and ALB (a host rule plus its own SNI certificate); own cluster and task group.
 * Runbook: `docs/electric-sync.md`.
 */
export const createMapleElectric = ({
	stage,
	region,
	profile,
	network,
	listener,
	albSecurityGroupId,
	hostname,
	dbRole,
}: CreateMapleElectricOptions) =>
	Effect.gen(function* () {
		const { taskSize, dbPoolSize } = profile.electric
		const name = (base: string) => resolveAwsResourceName(base, stage, region)
		const tags = { Service: "maple-electric", Region: region }

		// Only the shared ALB may reach ELECTRIC_PORT; otherwise a task's public IP serves
		// plaintext around the cert. The ALB itself admits only Cloudflare (ingest's group),
		// which is fine: electric-sync reaches this through the proxied hostname.
		const taskSecurityGroup = yield* AWS.EC2.SecurityGroup("electric-task-sg", {
			vpcId: network.vpcId,
			groupName: name("electric-task"),
			description: "Maple ElectricSQL sync service",
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: ELECTRIC_PORT,
					toPort: ELECTRIC_PORT,
					referencedGroupId: albSecurityGroupId,
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

		const certificateArn = yield* issueRegionalCertificate({
			id: "electric-cert",
			hostname,
			region: resolveAwsRegion(region),
			tags,
		})
		// SNI: the listener's default certificate is ingest's.
		if (certificateArn) {
			yield* AWS.ELBv2.ListenerCertificate("electric-listener-cert", {
				listenerArn: listener,
				certificateArn,
			})
		}

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
			securityGroups: [taskSecurityGroup.groupId],
			assignPublicIp: true,

			// Public: the caller is a Worker with no route into the VPC; ELECTRIC_SECRET guards it.
			// The explicit `forward` names a fresh target group: an ALB target group belongs to
			// one load balancer, so the one from electric's former ALB can't move here.
			port: ELECTRIC_PORT,
			loadBalancer: {
				listener,
				// Ahead of ingest's catch-all (priority 50000).
				rules: [{ host: hostname, forward: `${ELECTRIC_PORT}/http`, priority: 10 }],
			},
			healthCheckPath: "/v1/health",
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

		// The public name, proxied through Cloudflare to the shared ALB.
		yield* publishProxiedCname({
			id: "electric-public-cname",
			hostname,
			serviceUrl: service.url,
		})

		return { serviceUrl: service.url }
	})
