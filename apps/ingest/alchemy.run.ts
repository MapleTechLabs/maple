import { existsSync } from "node:fs"
import { resolve } from "node:path"
import * as AWS from "alchemy/AWS"
import * as Output from "alchemy/Output"
import type * as Planetscale from "alchemy/Planetscale"
import * as Effect from "effect/Effect"
import {
	COLLECTOR_DNS_LABEL,
	COLLECTOR_OTLP_HTTP_PORT,
	ecsSecrets,
	pgUrlRequireSsl,
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveCollectorEndpoint,
	resolveIngestCidrBlock,
	resolveIngestNamespaceName,
} from "@maple/infra/aws"
import { ReplayBlobs } from "../api/src/resources/replay-blobs.ts"
import { cloudflareIpv4Ranges, issueRegionalCertificate, publishProxiedCname } from "@maple/infra/acm"
import type { MapleRegion, MapleStackContext, MapleStage } from "@maple/infra/cloudflare"
import {
	resolveDeploymentEnvironment,
	resolveStorageJurisdiction,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { r2BucketCredentials } from "@maple/infra/r2-credentials"
// Only the primitives: these values feed ECS `env:` and Secrets Manager, not Worker bindings.
import { optionalPlain, requiredPlain } from "@maple/infra/env"

/** Compiled ahead of time by CI so the image build is a COPY. Absent on a dev machine. */
const PREBUILT_BINARY = "apps/ingest/dist/maple-ingest"
/**
 * Absolute on purpose: alchemy has changed how a relative `dockerfile` resolves
 * between releases, and each change broke the deploy (docs/infra.md).
 */
const PREBUILT_DOCKERFILE = resolve("apps/ingest/Dockerfile.prebuilt")

/** Its own build context so a collector config change does not rebuild and roll the gateway. */
const COLLECTOR_CONTEXT = "packages/infra/otel-collector"
const COLLECTOR_DOCKERFILE = resolve(COLLECTOR_CONTEXT, "Dockerfile")

/** Port the gateway binds (`apps/ingest/Dockerfile` EXPOSEs the same). */
const INGEST_PORT = 3474

/**
 * WAL cap, sized to fit the smallest host's NVMe instance store (c7gd.medium, 59 GB).
 * The per-lane budget is `INGEST_QUEUE_MAX_BYTES / (WAL_SHARDS * lanes)`.
 */
const WAL_MAX_BYTES = 48 * 1024 * 1024 * 1024

/**
 * Pinned rather than derived: the gateway defaults to `num_cpus * 2`, which
 * would reshape the on-disk WAL whenever the task size changes.
 */
const WAL_SHARDS = 4

/** Where the gateway keeps its WAL inside the container (the binary's default `INGEST_QUEUE_DIR`). */
const WAL_CONTAINER_DIR = "/var/lib/maple-ingest/wal"

/** The host's instance-store NVMe, mounted by `ec2UserData`. */
const WAL_HOST_DIR = "/mnt/wal"

/**
 * Boot script for a gateway host (ECS-optimized AL2023). Mounts the NVMe at
 * WAL_HOST_DIR and only THEN joins the cluster, so a host whose disk did not
 * come up never gets a task. The S3 tier covers the disk being wiped on replace.
 */
const ec2UserData = (clusterName: string) => `#!/bin/bash
set -euxo pipefail

disk=$(ls /dev/disk/by-id/nvme-Amazon_EC2_NVMe_Instance_Storage_* | grep -v -- -part | head -n1)
mkfs.xfs -f "$disk"
mkdir -p ${WAL_HOST_DIR}
echo "UUID=$(blkid -s UUID -o value "$disk") ${WAL_HOST_DIR} xfs noatime,nofail 0 2" >> /etc/fstab
mount ${WAL_HOST_DIR}

cat >> /etc/ecs/ecs.config <<'CONFIG'
ECS_CLUSTER=${clusterName}
ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true
ECS_CONTAINER_STOP_TIMEOUT=120s
CONFIG
`

export interface CreateMapleIngestOptions extends Pick<
	MapleStackContext,
	"stage" | "region" | "domains" | "profile"
> {
	/** prd's gateway role; a stage without a database branch reads `MAPLE_INGEST_PG_URL` instead. */
	dbRole?: Planetscale.PostgresRole
}

/**
 * The gateway's write credentials for the replay payload store
 * (`apps/api/src/resources/replay-blobs.ts`), or `undefined` on a stage that
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
			jurisdiction: resolveStorageJurisdiction(region),
			permissions: ["Workers R2 Storage Bucket Item Write"],
		})
		return { ...credentials, bucket }
	})

/**
 * The Rust OTLP gateway (`apps/ingest`) on ECS, one fleet per `MapleRegion`:
 * ARM64 EC2 hosts with the WAL on local NVMe, behind a public ALB, plus an OTel
 * collector for the gateway's own telemetry, reached by Cloud Map private DNS.
 */
export const createMapleIngest = ({ stage, region, domains, profile, dbRole }: CreateMapleIngestOptions) =>
	Effect.gen(function* () {
		const replayBlobs = yield* replayBlobWriterCredentials(stage, region, profile.deploys.replayBlobs)
		const { desiredCount, scaling, instanceType, taskSize, collectorTaskSize, selfTraceSampleRatio } =
			profile.ingest
		const name = (base: string) => resolveAwsResourceName(base, stage, region)
		const tags = { Service: "maple-ingest", Region: region }

		// Public subnets and NO NAT gateway: NAT's per-GB processing fee would
		// outweigh compute and egress combined for a service that pushes telemetry out.
		const network = yield* AWS.EC2.Network("ingest-network", {
			cidrBlock: resolveIngestCidrBlock(region),
			availabilityZones: 2,
			nat: "none",
			gatewayEndpoints: ["s3"],
			tags,
		})

		// With an ingest domain the ALB terminates TLS on 443 behind Cloudflare's proxy, and
		// admits only Cloudflare's edge: that is what makes `Cf-IPCountry` trustworthy. A stage
		// without one (PR previews) gets alchemy's default HTTP listener on 80, open to all.
		// The group's `description` must not change: AWS treats it as immutable (a replace).
		const listenerPort = domains.ingest ? 443 : 80
		const albSources = domains.ingest
			? (yield* cloudflareIpv4Ranges).map((cidr) => ({
					cidr,
					description: "OTLP over HTTPS from Cloudflare",
				}))
			: [{ cidr: "0.0.0.0/0", description: "OTLP over HTTP (no ingest domain, no certificate)" }]
		const albSecurityGroup = yield* AWS.EC2.SecurityGroup("ingest-alb-sg", {
			vpcId: network.vpcId,
			groupName: name("ingest-alb"),
			description: `Maple OTLP ingest - public ${listenerPort === 443 ? "HTTPS" : "HTTP"} to the load balancer`,
			ingress: albSources.map(({ cidr, description }) => ({
				ipProtocol: "tcp",
				fromPort: listenerPort,
				toPort: listenerPort,
				cidrIpv4: cidr,
				description,
			})),
		})

		// ── Capacity ────────────────────────────────────────────────────────
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

		// Newest ECS-optimized AL2023 arm64 image. Every deploy launches fresh hosts
		// (the old task holds the port), so AMI patching rides the deploys.
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
			userData: ec2UserData(clusterName),
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

		const tinybirdToken = yield* secret("tinybird-token", yield* requiredPlain("TINYBIRD_TOKEN"))
		// NOT `MAPLE_PG_URL`: that is the migration admin's URL. The gateway reads
		// ingest keys through the pooler as its own role.
		const pgUrl = dbRole
			? yield* secret("maple-pg-url", pgUrlRequireSsl(dbRole.connectionUrlPooled))
			: yield* secret("maple-pg-url", yield* requiredPlain("MAPLE_INGEST_PG_URL"))
		const keyEncryptionKey = yield* secret(
			"ingest-key-encryption-key",
			yield* requiredPlain("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
		)
		const keyLookupHmacKey = yield* secret(
			"ingest-key-lookup-hmac-key",
			yield* requiredPlain("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
		)

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

		// ── OTel collector ──────────────────────────────────────────────────
		// prd only (`profile.deploys.collector`); MAPLE_DEPLOY_AWS_COLLECTOR=1 forces it
		// on for one deploy, which is how a preview tests it.
		const deployCollector =
			profile.deploys.collector ||
			(yield* optionalPlain("MAPLE_DEPLOY_AWS_COLLECTOR")).MAPLE_DEPLOY_AWS_COLLECTOR === "1"
		const collectorEndpoint = deployCollector ? resolveCollectorEndpoint(stage, region) : undefined
		if (deployCollector) {
			// Reachable only from the gateway hosts. The tasks carry public IPs, so
			// without this rule the receiver would be dialable from anywhere.
			const collectorSecurityGroup = yield* AWS.EC2.SecurityGroup("otel-collector-sg", {
				vpcId: network.vpcId,
				groupName: name("otel-collector"),
				description: "Maple OTel collector - OTLP/HTTP from the ingest gateway tasks",
				ingress: [
					{
						ipProtocol: "tcp",
						fromPort: COLLECTOR_OTLP_HTTP_PORT,
						toPort: COLLECTOR_OTLP_HTTP_PORT,
						referencedGroupId: instanceSecurityGroup.groupId,
						description: "Ingest gateway hosts to collector",
					},
				],
			})

			// Both DNS labels are chosen here, so `resolveCollectorEndpoint` is a plain
			// string at plan time. Hence the explicit Cloud Map service rather than
			// alchemy's `serviceRegistry:` sugar, which generates the name.
			const namespace = yield* AWS.CloudMap.PrivateDnsNamespace("ingest-dns", {
				name: resolveIngestNamespaceName(stage, region),
				vpc: network.vpcId,
				description: "Maple ingest fleet - private service discovery",
				tags,
			})
			const collectorDiscovery = yield* AWS.CloudMap.Service("otel-collector-discovery", {
				name: COLLECTOR_DNS_LABEL,
				namespaceId: namespace.namespaceId,
				description: "Maple OTel collector",
				dnsRecords: [{ type: "A", ttl: "10 seconds" }],
				healthCheckCustomConfig: { failureThreshold: 1 },
				tags,
			})

			yield* AWS.ECS.Service("otel-collector", {
				cluster,
				serviceName: name("otel-collector"),
				// The pinned upstream contrib image with the config baked in. Not the ghcr
				// `otel-collector-maple` image: that build has no `tinybird` exporter.
				context: COLLECTOR_CONTEXT,
				dockerfile: COLLECTOR_DOCKERFILE,
				runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
				cpu: collectorTaskSize.cpu,
				memory: collectorTaskSize.memory,
				// One task: the gateway's OTLP exporters retry in memory across a restart.
				desiredCount: 1,
				vpcId: network.vpcId,
				subnets: network.publicSubnetIds,
				securityGroups: [collectorSecurityGroup.groupId],
				assignPublicIp: true,
				port: COLLECTOR_OTLP_HTTP_PORT,
				serviceRegistries: [{ registryArn: collectorDiscovery.serviceArn }],
				logging: { retention: "30 days" },
				secrets: { TINYBIRD_TOKEN: tinybirdToken.secretArn },
				env: { TINYBIRD_HOST: yield* requiredPlain("TINYBIRD_HOST") } satisfies Record<
					string,
					string
				>,
				tags,
			})
		}

		const issuedCertificateArn = yield* issueRegionalCertificate({
			id: "ingest-cert",
			hostname: domains.ingest,
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
		// silently returns the first registration.
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
			},

			desiredCount,
			// alchemy stops pinning desiredCount while `scaling` is set.
			...(scaling ? { scaling } : undefined),
			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [albSecurityGroup.groupId],

			public: true,
			// `port` is the CONTAINER port; the listener defaults to 443 with a
			// certificate. Do not set `listenerPort`: Cloudflare cannot proxy to 3474.
			port: INGEST_PORT,
			healthCheckPath: "/health",
			...(issuedCertificateArn ? { certificateArn: issuedCertificateArn } : undefined),
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
				MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
				// Lets the unknown-key 401 name the other region's ingest URL.
				...(stage.kind === "prd" && { MAPLE_REGION: region }),
				TINYBIRD_HOST: yield* requiredPlain("TINYBIRD_HOST"),
				INGEST_KEY_STORE_BACKEND: "postgres",
				// A replaced role changes the task definition, so the fleet rolls onto the
				// new secret before alchemy deletes the old role.
				...(dbRole && { MAPLE_PG_ROLE_ID: dbRole.id }),

				// Trust `Cf-IPCountry` (fills `session_replays.Country`) only where the ALB admits
				// nothing but Cloudflare; a preview's open ALB would let any client set it.
				...(domains.ingest && { MAPLE_INGEST_TRUST_PROXY_GEO: "true" }),

				INGEST_QUEUE_MAX_BYTES: String(WAL_MAX_BYTES),
				INGEST_WAL_SHARDS: String(WAL_SHARDS),
				// The task role signs these requests; the S3 gateway endpoint keeps them private.
				INGEST_WAL_S3_BUCKET: walBucketName,
				INGEST_WAL_S3_REGION: resolveAwsRegion(region),
				...(yield* optionalPlain("INGEST_WAL_SEGMENT_MAX_BYTES")),
				...(yield* optionalPlain("INGEST_WAL_S3_ORPHAN_AFTER_SECS")),

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
				...(yield* optionalPlain("INGEST_WRITE_MODE")),
				...(yield* optionalPlain("INGEST_BATCH_MAX_ROWS")),
				...(yield* optionalPlain("INGEST_BATCH_MAX_BYTES")),
				...(yield* optionalPlain("INGEST_BATCH_MAX_WAIT_MS")),
				...(yield* optionalPlain("INGEST_ORG_QUEUE_MAX_BYTES")),
				...(yield* optionalPlain("INGEST_ORG_MAX_IN_FLIGHT")),
				...(yield* optionalPlain("INGEST_REQUEST_TIMEOUT_SECS")),
				...(yield* optionalPlain("INGEST_QUEUE_MAX_AGE_SECS")),
				...(yield* optionalPlain("INGEST_MAX_REQUEST_BODY_BYTES")),
				...(yield* optionalPlain("INGEST_EXPORT_MAX_ATTEMPTS")),
				...(yield* optionalPlain("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD")),
				...(yield* optionalPlain("INGEST_REPLAY_MAX_SESSION_BYTES")),
				// The org Maple's own telemetry is filed under. Required, no fallback.
				MAPLE_INTERNAL_ORG_ID: yield* requiredPlain("MAPLE_INTERNAL_ORG_ID"),
				...(yield* optionalPlain("AUTUMN_API_URL")),
				// Entitlement cache TTLs (defaults in `AppConfig::from_env`). The allow TTL
				// is how soft a hard cap is.
				...(yield* optionalPlain("AUTUMN_ENTITLEMENT_ALLOW_TTL_SECS")),
				...(yield* optionalPlain("AUTUMN_ENTITLEMENT_DENY_TTL_SECS")),
				// 30s instead of the binary's 1s cuts Autumn track calls ~30x.
				...(yield* optionalPlain("AUTUMN_FLUSH_INTERVAL_SECS", "30")),
				...(yield* optionalPlain("INGEST_SHUTDOWN_DRAIN_SECS")),
				...(yield* optionalPlain("COMMIT_SHA", (yield* optionalPlain("GITHUB_SHA")).GITHUB_SHA)),
			} satisfies Record<string, string | Output.Output<string>>,

			tags,
		})

		// The public name, proxied through Cloudflare to the ALB.
		if (domains.ingest) {
			yield* publishProxiedCname({
				id: "ingest-public-cname",
				hostname: domains.ingest,
				serviceUrl: service.url,
			})
		}

		return {
			// The ALB. A PR preview has no ingest domain and is reached here.
			serviceUrl: service.url,
			// Shared with `apps/electric`: two `AWS.EC2.Network`s in one stack fight
			// over the internet gateway.
			network,
			// Resolvable only inside the VPC; surfaced so a preview's logs say where the gateway points.
			collectorEndpoint,
		}
	})
