import { existsSync } from "node:fs"
import { resolve } from "node:path"
import * as AWS from "@alchemy.run/aws"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import { ecsSecrets, pgUrlRequireSsl, resolveAwsRegion } from "@maple/infra/aws"
import { cloudflareIpv4Ranges, issueRegionalCertificate, publishProxiedCname } from "@maple/infra/acm"
import type { MapleDbLogin, MapleRegion, MapleStackContext, MapleStage } from "@maple/infra/cloudflare"
import {
	REGION_INFRA,
	ReplayBlobs,
	resolveDeploymentEnvironment,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { r2BucketCredentials } from "@maple/infra/r2-credentials"
// Only the primitives: these values feed ECS `env:` and Secrets Manager, not Worker bindings.
import { commitShaEnv, optionalPlain, requiredPlain } from "@maple/infra/env"
import { createIngestCollector } from "./alchemy/collector.ts"
import { blockedIngestKeysEnv, blockIngestKeysAtEdge } from "./alchemy/edge-block.ts"
import { gatewayTuningEnv } from "./alchemy/gateway-env.ts"

/** Compiled ahead of time by CI so the image build is a COPY. Absent on a dev machine. */
const PREBUILT_BINARY = "apps/ingest/dist/maple-ingest"
/**
 * Absolute on purpose: alchemy has changed how a relative `dockerfile` resolves
 * between releases, and each change broke the deploy (docs/infra.md).
 */
const PREBUILT_DOCKERFILE = resolve("apps/ingest/Dockerfile.prebuilt")

/** Port the gateway binds (`apps/ingest/Dockerfile` EXPOSEs the same). */
const INGEST_PORT = 3474
/** The gateway's OTLP/gRPC server (`INGEST_OTLP_GRPC_PORT`), reached through the ALB. */
const INGEST_GRPC_PORT = 4317
/** OTLP/gRPC export paths: `/opentelemetry.proto.collector.<signal>.v1.<Signal>Service/Export`. */
const OTLP_GRPC_PATH = "/opentelemetry.proto.collector.*"

const GIB = 1024 * 1024 * 1024

/**
 * Where each host type keeps the WAL, and its cap. c7gd hosts mount their NVMe instance
 * store (59 GB on a medium); a t4g has none, so the WAL shares the 30 GB root volume.
 * The per-lane budget is `INGEST_QUEUE_MAX_BYTES / (WAL_SHARDS * lanes)`.
 */
const WAL_STORAGE = {
	"c7gd.large": { disk: "instance-store", maxBytes: 48 * GIB },
	"c7gd.medium": { disk: "instance-store", maxBytes: 48 * GIB },
	"t4g.small": { disk: "root-volume", maxBytes: 4 * GIB },
} as const satisfies Record<
	MapleStackContext["profile"]["ingest"]["instanceType"],
	{ disk: "instance-store" | "root-volume"; maxBytes: number }
>

/**
 * Pinned rather than derived: the gateway defaults to `num_cpus * 2`, which
 * would reshape the on-disk WAL whenever the task size changes.
 */
const WAL_SHARDS = 4

/** Where the gateway keeps its WAL inside the container (the binary's default `INGEST_QUEUE_DIR`). */
const WAL_CONTAINER_DIR = "/var/lib/maple-ingest/wal"

/** The host's instance-store NVMe (mounted by `ec2UserData`) or a root-volume directory. */
const WAL_HOST_DIR = "/mnt/wal"

/**
 * Boot script for a gateway host (ECS-optimized AL2023). An instance-store host mounts the
 * NVMe at WAL_HOST_DIR and only THEN joins the cluster, so a host whose disk did not come
 * up never gets a task. The S3 tier covers the disk being wiped on replace.
 */
const ec2UserData = (clusterName: string, disk: "instance-store" | "root-volume") => `#!/bin/bash
set -euxo pipefail

mkdir -p ${WAL_HOST_DIR}
${
	disk === "instance-store"
		? `disk=$(ls /dev/disk/by-id/nvme-Amazon_EC2_NVMe_Instance_Storage_* | grep -v -- -part | head -n1)
mkfs.xfs -f "$disk"
echo "UUID=$(blkid -s UUID -o value "$disk") ${WAL_HOST_DIR} xfs noatime,nofail 0 2" >> /etc/fstab
mount ${WAL_HOST_DIR}`
		: ""
}

cat >> /etc/ecs/ecs.config <<'CONFIG'
ECS_CLUSTER=${clusterName}
ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true
ECS_CONTAINER_STOP_TIMEOUT=120s
CONFIG
`

export interface CreateMapleIngestOptions extends Pick<MapleStackContext, "stage" | "region" | "profile"> {
	/** The public hostname (`domains.ingest`). Every stage that deploys a fleet has one. */
	hostname: string
	/** The declared database's gateway login; a stage without one reads `MAPLE_INGEST_PG_URL` instead. */
	dbLogin?: MapleDbLogin
}

/**
 * The gateway's write credentials for the replay payload store
 * (`ReplayBlobs`), or `undefined` on a stage that
 * keeps payloads inline (`profile.deploys.replayBlobs`).
 */
const replayBlobWriterCredentials = (stage: MapleStage, region: MapleRegion, enabled: boolean) =>
	Effect.gen(function* () {
		if (!enabled) return undefined
		// Yielded so the token is ordered behind the bucket.
		yield* ReplayBlobs
		const bucket = resolveWorkerName("replay-blobs", stage, region)
		const credentials = yield* r2BucketCredentials({
			id: "replay-blobs-writer",
			tokenName: `${bucket}-writer`,
			bucketName: bucket,
			jurisdiction: REGION_INFRA[region].storageJurisdiction,
			permissions: ["Workers R2 Storage Bucket Item Write"],
		})
		return { ...credentials, bucket }
	})

/**
 * The Rust OTLP gateway (`apps/ingest`) on ECS, one fleet per `MapleRegion`:
 * ARM64 EC2 hosts with the WAL on local NVMe, behind a public ALB, plus an OTel
 * collector for the gateway's own telemetry (`./alchemy/collector.ts`).
 */
export const createMapleIngest = ({ stage, region, hostname, profile, dbLogin }: CreateMapleIngestOptions) =>
	Effect.gen(function* () {
		const replayBlobs = yield* replayBlobWriterCredentials(stage, region, profile.deploys.replayBlobs)
		const { desiredCount, scaling, instanceType, taskSize, collectorTaskSize, selfTraceSampleRatio } =
			profile.ingest
		const name = (base: string) => resolveWorkerName(base, stage, region)
		const tags = { Service: "maple-ingest", Region: region }

		// Public subnets and NO NAT gateway: NAT's per-GB processing fee would
		// outweigh compute and egress combined for a service that pushes telemetry out.
		const network = yield* AWS.EC2.Network("ingest-network", {
			cidrBlock: REGION_INFRA[region].ingestCidrBlock,
			availabilityZones: 2,
			nat: "none",
			gatewayEndpoints: ["s3"],
			tags,
		})

		// The ALB terminates TLS on 443 behind Cloudflare's proxy and admits only Cloudflare's
		// edge: that is what makes `Cf-IPCountry` trustworthy. The group's `description` must not
		// change: AWS treats it as immutable (a replace).
		const albSecurityGroup = yield* AWS.EC2.SecurityGroup("ingest-alb-sg", {
			vpcId: network.vpcId,
			groupName: name("ingest-alb"),
			description: "Maple OTLP ingest - public HTTPS to the load balancer",
			ingress: (yield* cloudflareIpv4Ranges).map((cidr) => ({
				ipProtocol: "tcp",
				fromPort: 443,
				toPort: 443,
				cidrIpv4: cidr,
				description: "OTLP over HTTPS from Cloudflare",
			})),
		})

		// Host networking: an awsvpc task on EC2 cannot take a public IP, and without
		// one it has no egress in a VPC with no NAT. The ALB then targets instances,
		// which needs the `usesAwsvpc` change in `patches/alchemy@*.patch`.
		const clusterName = name("ingest")

		// The hosts carry public IPs, so this rule is what keeps plaintext OTLP
		// from reaching a host directly instead of through the ALB.
		const instanceSecurityGroup = yield* AWS.EC2.SecurityGroup("ingest-ec2-sg", {
			vpcId: network.vpcId,
			groupName: name("ingest-ec2"),
			description: "Maple OTLP ingest gateway hosts",
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: INGEST_PORT,
					toPort: INGEST_PORT,
					referencedGroupId: albSecurityGroup.groupId,
					description: "ALB to gateway",
				},
				{
					ipProtocol: "tcp",
					fromPort: INGEST_GRPC_PORT,
					toPort: INGEST_GRPC_PORT,
					referencedGroupId: albSecurityGroup.groupId,
					description: "ALB to gateway OTLP/gRPC",
				},
			],
		})

		// ECS agent registration, ECR pulls and logs, plus Session Manager instead of SSH.
		// The gateway itself gets the TASK role, not this one.
		const instanceRole = yield* AWS.IAM.Role("ingest-ec2-instance-role", {
			roleName: name("ingest-ec2-instance"),
			assumeRolePolicyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: { Service: "ec2.amazonaws.com" },
						Action: ["sts:AssumeRole"],
					},
				],
			},
			managedPolicyArns: [
				"arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
				"arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
			],
			tags,
		})
		const instanceProfile = yield* AWS.IAM.InstanceProfile("ingest-ec2-instance-profile", {
			instanceProfileName: name("ingest-ec2-instance"),
			roleName: instanceRole.roleName,
		})

		// Newest ECS-optimized AL2023 arm64 image. Every ingest rollout launches fresh hosts
		// (the old task holds the port), so AMI patching rides the ingest changes.
		const imageId = AWS.EC2.getAmi({
			owners: ["amazon"],
			name: ["al2023-ami-ecs-hvm-*-kernel-6.1-arm64"],
			architecture: "arm64",
		}).ImageId.as<string>()

		const launchTemplate = yield* AWS.AutoScaling.LaunchTemplate("ingest-ec2-launch-template", {
			launchTemplateName: name("ingest-ec2"),
			imageId,
			instanceType,
			securityGroupIds: [instanceSecurityGroup.groupId],
			instanceProfileName: instanceProfile.instanceProfileName,
			associatePublicIpAddress: true,
			userData: ec2UserData(clusterName, WAL_STORAGE[instanceType].disk),
			tags,
		})

		// ECS managed scaling owns the instance count (the patch keeps a redeploy from
		// resetting it to `minSize`). Max is doubled so a rolling deploy can overlap hosts.
		const maxTasks = scaling?.max ?? desiredCount
		const autoScalingGroup = yield* AWS.AutoScaling.AutoScalingGroup("ingest-ec2-asg", {
			autoScalingGroupName: name("ingest-ec2"),
			launchTemplate,
			subnetIds: network.publicSubnetIds,
			minSize: 0,
			maxSize: maxTasks * 2,
			healthCheckType: "EC2",
			healthCheckGracePeriod: "2 minutes",
			// ECS stamps this tag on adoption, and alchemy converges tags to the declared set.
			tags: { ...tags, AmazonECSManaged: "" },
		})

		// Managed draining: a scale-in drains the host's task first, and its SIGTERM
		// path empties the WAL (shutdown drain, then the S3 tier).
		const capacityProvider = yield* AWS.ECS.CapacityProvider("ingest-ec2-capacity", {
			name: name("ingest-ec2"),
			autoScalingGroupArn: autoScalingGroup.autoScalingGroupArn,
			managedScaling: {
				status: "ENABLED",
				targetCapacity: 100,
				minimumScalingStepSize: 1,
				maximumScalingStepSize: 2,
				instanceWarmupPeriod: 120,
			},
			managedTerminationProtection: "DISABLED",
			managedDraining: "ENABLED",
			tags,
		})

		const cluster = yield* AWS.ECS.Cluster("ingest-cluster", {
			clusterName,
			capacityProviders: [capacityProvider.name],
			tags,
		})

		const secret = ecsSecrets(name("ingest"), tags)

		const tinybirdTokenValue = yield* requiredPlain("TINYBIRD_TOKEN")
		const tinybirdToken = yield* secret("tinybird-token", tinybirdTokenValue)
		// NOT `MAPLE_PG_URL`: that is the migration admin's URL. The gateway reads
		// ingest keys through the pooler as its own role.
		const pgUrl = dbLogin
			? yield* secret("maple-pg-url", pgUrlRequireSsl(dbLogin.url))
			: yield* requiredPlain("MAPLE_INGEST_PG_URL").pipe(
					Effect.flatMap((url) => secret("maple-pg-url", url)),
				)
		const keyEncryptionKeyValue = yield* requiredPlain("MAPLE_INGEST_KEY_ENCRYPTION_KEY")
		const keyEncryptionKey = yield* secret("ingest-key-encryption-key", keyEncryptionKeyValue)
		// Only set while a key rotation is in flight (docs/secret-encryption.md).
		const { MAPLE_INGEST_KEY_DECRYPTION_KEYS: decryptionKeysValue } = yield* optionalPlain(
			"MAPLE_INGEST_KEY_DECRYPTION_KEYS",
		)
		const keyDecryptionKeys = decryptionKeysValue
			? yield* secret("ingest-key-decryption-keys", decryptionKeysValue)
			: undefined
		const keyLookupHmacKeyValue = yield* requiredPlain("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")
		const keyLookupHmacKey = yield* secret("ingest-key-lookup-hmac-key", keyLookupHmacKeyValue)

		// Autumn absent means billing enforcement is dark.
		const { AUTUMN_SECRET_KEY: autumnKey } = yield* optionalPlain("AUTUMN_SECRET_KEY")
		const autumnSecret = autumnKey ? yield* secret("autumn-secret-key", autumnKey) : undefined

		// The access key id is not secret, but it only exists once the token does and
		// `env` takes plan-time strings only.
		const replayR2Secret = replayBlobs
			? yield* secret("replay-r2-secret-access-key", replayBlobs.secretAccessKey)
			: undefined
		const replayR2AccessKeyId = replayBlobs
			? yield* secret("replay-r2-access-key-id", replayBlobs.accessKeyId)
			: undefined

		// prd only, or one preview that forces it (`profile.deploys.collector`).
		const collectorEndpoint = profile.deploys.collector
			? yield* createIngestCollector({
					stage,
					region,
					tags,
					network,
					cluster,
					gatewaySecurityGroupId: instanceSecurityGroup.groupId,
					tinybirdTokenArn: tinybirdToken.secretArn,
					taskSize: collectorTaskSize,
				})
			: undefined

		const issuedCertificateArn = yield* issueRegionalCertificate({
			id: "ingest-cert",
			hostname,
			region: resolveAwsRegion(region),
			tags,
		})

		// Durability tier for the WAL (`apps/ingest/src/wal_store.rs`): sealed,
		// unexported segments, claimed by the next task if their owner dies.
		// Named up front so the env var below is a plain string.
		const walBucketName = name("ingest-wal")
		const walSegments = yield* AWS.S3.Bucket("ingest-wal-segments", {
			bucketName: walBucketName,
			// Backstop for segments whose delete was lost.
			lifecycleRules: [
				{
					ID: "expire-wal-segments",
					Status: "Enabled",
					Filter: { Prefix: "wal/" },
					Expiration: { Days: 7 },
					AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
				},
			],
			publicAccessBlock: {
				blockPublicAcls: true,
				blockPublicPolicy: true,
				ignorePublicAcls: true,
				restrictPublicBuckets: true,
			},
			encryption: { sseAlgorithm: "AES256" },
			forceDestroy: true,
			tags,
		})

		// Its own logical id: alchemy keys resources by id alone, and a repeat id
		// silently returns the first registration. Keep these policies without a
		// `description`: changing one replaces the policy under the same name, and the
		// patched delete detaches the old one from the live task role.
		const walSegmentsPolicy = yield* AWS.IAM.Policy("ingest-wal-segments-access", {
			policyName: name("ingest-wal-segments"),
			policyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
						Resource: [Output.map(walSegments.bucketArn, (arn) => `${arn}/wal/*`)],
					},
					{
						Effect: "Allow",
						Action: ["s3:ListBucket"],
						Resource: [walSegments.bucketArn],
						Condition: { StringLike: { "s3:prefix": ["wal/*"] } },
					},
				],
			},
		})

		// The gateway marks its own task scale-in-protected while the WAL holds
		// backlog (`apps/ingest/src/task_protection.rs`).
		const taskProtectionPolicy = yield* AWS.IAM.Policy("ingest-task-protection", {
			policyName: name("ingest-task-protection"),
			policyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: ["ecs:UpdateTaskProtection"],
						Resource: [
							Output.map(
								cluster.clusterArn,
								(arn) => `${arn.replace(":cluster/", ":task/")}/*`,
							),
						],
					},
				],
			},
		})

		// One task per host, bound to the host's port and NVMe. A rolling deploy brings
		// up a fresh host for the new task (the port is taken) and drains the old one.
		// `securityGroups` reaches only the ALB here: the host's own group admits it.
		const service = yield* AWS.ECS.Service("ingest-ec2", {
			cluster,
			serviceName: name("ingest-ec2"),
			taskRoleManagedPolicyArns: [taskProtectionPolicy.policyArn, walSegmentsPolicy.policyArn],

			// Rebuilt only when the context hash changes. CI leaves a prebuilt binary
			// at dist/ (fast COPY build); without it this falls back to a source build.
			context: "apps/ingest",
			...(existsSync(PREBUILT_BINARY) ? { dockerfile: PREBUILT_DOCKERFILE } : undefined),
			// The docker build platform is derived from this, so the binary must be
			// aarch64 too: a mismatch only shows up as `exec format error` at runtime.
			runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
			networkMode: "host",
			requiresCompatibilities: ["EC2"],
			capacityProviderStrategy: [{ capacityProvider: capacityProvider.name, weight: 1 }],
			placementConstraints: [{ type: "distinctInstance" }],
			cpu: taskSize.cpu,
			memory: taskSize.memory,
			volumes: [{ name: "wal", host: { sourcePath: WAL_HOST_DIR } }],
			container: {
				// The shutdown drain (`INGEST_SHUTDOWN_DRAIN_SECS`, default 90) must fit inside this.
				stopTimeout: 120,
				mountPoints: [{ sourceVolume: "wal", containerPath: WAL_CONTAINER_DIR }],
				// Replaces the mapping alchemy derives from `port`; host mode needs hostPort = containerPort.
				portMappings: [INGEST_PORT, INGEST_GRPC_PORT].map((port) => ({
					containerPort: port,
					hostPort: port,
					protocol: "tcp",
				})),
			},

			desiredCount,
			// alchemy stops pinning desiredCount while `scaling` is set.
			...(scaling ? { scaling } : undefined),
			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [albSecurityGroup.groupId],

			// The conditionless rule is the listener's default action, the same ALB, listener
			// and target group `true` composes. OTLP/gRPC paths go to a gRPC target group.
			loadBalancer: {
				rules: [
					{},
					{
						path: OTLP_GRPC_PATH,
						forward: `${INGEST_GRPC_PORT}/http`,
						protocolVersion: "GRPC",
					},
				],
			},
			// `port` is the CONTAINER port; the listener defaults to 443 with a
			// certificate. Do not set `listenerPort`: Cloudflare cannot proxy to 3474.
			port: INGEST_PORT,
			healthCheckPath: "/health",
			certificateArn: issuedCertificateArn,
			// Covers the startup Postgres probe, which exits the process on failure.
			healthCheckGracePeriod: "60 seconds",
			// Old tasks stay scale-in protected for up to 15 minutes while the WAL drains,
			// which outlasts alchemy's 10-minute default.
			deploymentStabilizationTimeout: "25 minutes",

			logging: { retention: "30 days" },

			secrets: {
				TINYBIRD_TOKEN: tinybirdToken.secretArn,
				MAPLE_PG_URL: pgUrl.secretArn,
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: keyEncryptionKey.secretArn,
				...(keyDecryptionKeys
					? { MAPLE_INGEST_KEY_DECRYPTION_KEYS: keyDecryptionKeys.secretArn }
					: undefined),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: keyLookupHmacKey.secretArn,
				...(autumnSecret ? { AUTUMN_SECRET_KEY: autumnSecret.secretArn } : undefined),
				...(replayR2Secret && replayR2AccessKeyId
					? {
							INGEST_REPLAY_R2_SECRET_ACCESS_KEY: replayR2Secret.secretArn,
							INGEST_REPLAY_R2_ACCESS_KEY_ID: replayR2AccessKeyId.secretArn,
						}
					: undefined),
			},

			// `optionalPlain` returns a Config: always `yield*` it before spreading, or the
			// variable is silently dropped. The `satisfies` below turns that into a type error.
			env: {
				INGEST_PORT: String(INGEST_PORT),
				INGEST_OTLP_GRPC_PORT: String(INGEST_GRPC_PORT),
				MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
				// Lets the unknown-key 401 name the other region's ingest URL.
				...(stage.kind === "prd" && { MAPLE_REGION: region }),
				TINYBIRD_HOST: yield* requiredPlain("TINYBIRD_HOST"),
				INGEST_KEY_STORE_BACKEND: "postgres",
				// A replaced role changes the task definition, so the fleet rolls onto the
				// new secret before alchemy deletes the old role.
				...(dbLogin && { MAPLE_PG_ROLE_ID: dbLogin.id }),

				// Trust `Cf-IPCountry` (fills `session_replays.Country`): the ALB admits only Cloudflare.
				MAPLE_INGEST_TRUST_PROXY_GEO: "true",

				INGEST_QUEUE_MAX_BYTES: String(WAL_STORAGE[instanceType].maxBytes),
				INGEST_WAL_SHARDS: String(WAL_SHARDS),
				// The task role signs these requests; the S3 gateway endpoint keeps them private.
				INGEST_WAL_S3_BUCKET: walBucketName,
				INGEST_WAL_S3_REGION: resolveAwsRegion(region),

				...(replayBlobs
					? {
							INGEST_REPLAY_R2_ENDPOINT: replayBlobs.endpoint,
							INGEST_REPLAY_R2_BUCKET: replayBlobs.bucket,
							...(yield* optionalPlain("INGEST_REPLAY_R2_REGION", "auto")),
						}
					: undefined),

				// The gateway's own telemetry (and customer OTLP in forward/dual mode)
				// goes to the in-VPC collector when this stage runs one.
				...(collectorEndpoint
					? { INGEST_FORWARD_OTLP_ENDPOINT: collectorEndpoint }
					: yield* optionalPlain("INGEST_FORWARD_OTLP_ENDPOINT")),
				...(selfTraceSampleRatio
					? { INGEST_SELF_TRACE_SAMPLE_RATIO: selfTraceSampleRatio }
					: yield* optionalPlain("INGEST_SELF_TRACE_SAMPLE_RATIO")),
				// Source token rps limits are split across this many tasks. The scaling
				// floor, so a scaled-out fleet admits more rather than throttling below the limit.
				INGEST_RATE_LIMIT_FLEET_SIZE: String(scaling?.min ?? desiredCount),
				...(yield* blockedIngestKeysEnv),
				// The org Maple's own telemetry is filed under. Required, no fallback.
				MAPLE_INTERNAL_ORG_ID: yield* requiredPlain("MAPLE_INTERNAL_ORG_ID"),
				// On wherever a stage is deployed whole and never rolled back to an older gateway; prd
				// turns it on in its environment once `audit_trail_events` is there.
				...(stage.kind !== "prd" && { INGEST_AUDIT_TRAIL_ENABLED: "true" }),
				...(yield* gatewayTuningEnv),
				// `INGEST_COMMIT_SHA` (prd) is the image's own revision, so a deploy that leaves
				// `apps/ingest` alone does not change the task definition and roll the hosts.
				...(yield* commitShaEnv("INGEST_COMMIT_SHA")),
			} satisfies Record<string, string | Output.Output<string>>,

			tags,
		})

		// The public name, proxied through Cloudflare to the ALB.
		yield* publishProxiedCname({ id: "ingest-public-cname", hostname, serviceUrl: service.url })

		if (stage.kind === "prd" && region === "us") yield* blockIngestKeysAtEdge(stage)

		return {
			// The ALB itself, behind the public hostname.
			serviceUrl: service.url,
			// Shared with `apps/electric`: two `AWS.EC2.Network`s in one stack fight
			// over the internet gateway.
			network,
			// Resolvable only inside the VPC; surfaced so a preview's logs say where the gateway points.
			collectorEndpoint,
		}
	})
