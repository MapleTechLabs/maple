/**
 * The OTel collector beside the gateway (`profile.deploys.collector`): the gateway's own telemetry,
 * and customer OTLP in forward/dual mode, reach it by Cloud Map private DNS inside the VPC.
 */
import { resolve } from "node:path"
import * as AWS from "@alchemy.run/aws"
import type * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import {
	COLLECTOR_DNS_LABEL,
	COLLECTOR_OTLP_HTTP_PORT,
	resolveCollectorEndpoint,
	resolveIngestNamespaceName,
} from "@maple/infra/aws"
import { type MapleRegion, type MapleStage, resolveWorkerName } from "@maple/infra/cloudflare"
import { requiredPlain } from "@maple/infra/env"
import type { TaskSize } from "@maple/infra/profile"

/** Its own build context so a collector config change does not rebuild and roll the gateway. */
const COLLECTOR_CONTEXT = "packages/infra/otel-collector"
const COLLECTOR_DOCKERFILE = resolve(COLLECTOR_CONTEXT, "Dockerfile")

export interface IngestCollectorOptions {
	readonly stage: MapleStage
	readonly region: MapleRegion
	readonly tags: Record<string, string>
	readonly network: Pick<AWS.EC2.Network, "vpcId" | "publicSubnetIds">
	readonly cluster: AWS.ECS.Cluster
	/** The gateway hosts' security group, the only source the receiver admits. */
	readonly gatewaySecurityGroupId: AWS.EC2.SecurityGroup["groupId"]
	readonly tinybirdTokenArn: Output.Output<string>
	readonly taskSize: TaskSize
}

/** Declares the collector and returns the gateway's `INGEST_FORWARD_OTLP_ENDPOINT`, a plain string at plan time. */
export const createIngestCollector = ({
	stage,
	region,
	tags,
	network,
	cluster,
	gatewaySecurityGroupId,
	tinybirdTokenArn,
	taskSize,
}: IngestCollectorOptions) =>
	Effect.gen(function* () {
		const name = (base: string) => resolveWorkerName(base, stage, region)
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
					referencedGroupId: gatewaySecurityGroupId,
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
			cpu: taskSize.cpu,
			memory: taskSize.memory,
			// One task: the gateway's OTLP exporters retry in memory across a restart.
			desiredCount: 1,
			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [collectorSecurityGroup.groupId],
			assignPublicIp: true,
			port: COLLECTOR_OTLP_HTTP_PORT,
			serviceRegistries: [{ registryArn: collectorDiscovery.serviceArn }],
			logging: { retention: "30 days" },
			secrets: { TINYBIRD_TOKEN: tinybirdTokenArn },
			env: { TINYBIRD_HOST: yield* requiredPlain("TINYBIRD_HOST") } satisfies Record<string, string>,
			tags,
		})

		return resolveCollectorEndpoint(stage, region)
	})
