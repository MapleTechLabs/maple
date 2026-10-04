import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { parseMapleStage } from "../cloudflare/stage.ts"
import {
	type MapleRegion,
	parseIngestFleets,
	parseMapleRegion,
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveCollectorEndpoint,
	resolveCollectorTaskSize,
	resolveElectricDbPoolSize,
	resolveIngestCidrBlock,
	resolveIngestDesiredCount,
	resolveIngestEc2InstanceType,
	resolveIngestEc2TaskSize,
	resolveIngestNamespaceName,
	resolveIngestScaling,
	resolveIngestSelfTraceSampleRatio,
	stageDeploysCollector,
	stageDeploysIngest,
	stageEnablesReplayBlobs,
} from "./stage.ts"

describe("parseMapleRegion", () => {
	it("defaults to us when unset", () => {
		expect(parseMapleRegion(undefined)).toBe("us")
		expect(parseMapleRegion("")).toBe("us")
		expect(parseMapleRegion("  ")).toBe("us")
	})

	it("accepts either region, case-insensitively", () => {
		expect(parseMapleRegion("EU")).toBe("eu")
		expect(parseMapleRegion(" us ")).toBe("us")
	})

	it("rejects anything else rather than silently defaulting", () => {
		expect(() => parseMapleRegion("apac")).toThrow(/Unsupported Maple region/)
	})
})

describe("resolveAwsResourceName", () => {
	it("leaves us unsuffixed so adding eu renames nothing", () => {
		expect(resolveAwsResourceName("ingest", parseMapleStage("prd"), "us")).toBe("maple-ingest")
		expect(resolveAwsResourceName("ingest", parseMapleStage("pr-12"), "us")).toBe("maple-ingest-pr-12")
	})

	it("defaults to us when no region is passed", () => {
		expect(resolveAwsResourceName("ingest", parseMapleStage("prd"))).toBe("maple-ingest")
	})

	it("suffixes eu, keeping the two instances distinct at every stage", () => {
		expect(resolveAwsResourceName("ingest", parseMapleStage("prd"), "eu")).toBe("maple-ingest-eu")
		expect(resolveAwsResourceName("ingest", parseMapleStage("pr-12"), "eu")).toBe("maple-ingest-eu-pr-12")
	})

	it("rejects the removed stg stage rather than naming a dev stack after it", () => {
		expect(() => parseMapleStage("stg")).toThrow(/"stg" stage was removed/)
	})
})

describe("region topology", () => {
	it("maps each region to a distinct AWS region and a non-overlapping CIDR", () => {
		expect(resolveAwsRegion("us")).toBe("us-east-1")
		expect(resolveAwsRegion("eu")).toBe("eu-central-1")
		expect(resolveIngestCidrBlock("us")).not.toBe(resolveIngestCidrBlock("eu"))
	})
})

describe("collector service discovery", () => {
	it("puts the collector in a per-stage namespace the gateway can name at plan time", () => {
		expect(resolveIngestNamespaceName(parseMapleStage("prd"))).toBe("maple-ingest.internal")
		expect(resolveIngestNamespaceName(parseMapleStage("pr-12"))).toBe("maple-ingest-pr-12.internal")
		expect(resolveIngestNamespaceName(parseMapleStage("prd"), "eu")).toBe("maple-ingest-eu.internal")
	})

	it("derives the gateway's forward endpoint from the same names", () => {
		expect(resolveCollectorEndpoint(parseMapleStage("prd"))).toBe(
			"http://otel-collector.maple-ingest.internal:4318",
		)
		expect(resolveCollectorEndpoint(parseMapleStage("pr-12"), "eu")).toBe(
			"http://otel-collector.maple-ingest-eu-pr-12.internal:4318",
		)
	})

	it("deploys the gateway to every deployed stage, but never to a dev stage", () => {
		expect(stageDeploysIngest(parseMapleStage("prd"))).toBe(true)
		expect(stageDeploysIngest(parseMapleStage("pr-12"))).toBe(true)
		expect(stageDeploysIngest(parseMapleStage("dev-alice"))).toBe(false)
	})

	it("writes replay blobs on prd, and only where the gateway runs", () => {
		expect(stageEnablesReplayBlobs(parseMapleStage("prd"))).toBe(true)
		expect(stageEnablesReplayBlobs(parseMapleStage("pr-12"))).toBe(false)
		expect(stageEnablesReplayBlobs(parseMapleStage("dev-alice"))).toBe(false)
		// A stage cannot write blobs without a gateway to write them.
		for (const stage of ["prd", "pr-12", "dev-alice"]) {
			if (stageEnablesReplayBlobs(parseMapleStage(stage))) {
				expect(stageDeploysIngest(parseMapleStage(stage))).toBe(true)
			}
		}
	})

	it("deploys the collector to prd only for now, a subset of the gateway stages", () => {
		expect(stageDeploysCollector(parseMapleStage("prd"))).toBe(true)
		expect(stageDeploysCollector(parseMapleStage("pr-12"))).toBe(false)
		for (const stage of ["prd", "pr-12", "dev-alice"]) {
			if (stageDeploysCollector(parseMapleStage(stage))) {
				expect(stageDeploysIngest(parseMapleStage(stage))).toBe(true)
			}
		}
	})

	it("sizes the collector task with 1 GiB everywhere so the memory limiter can fire", () => {
		expect(resolveCollectorTaskSize(parseMapleStage("prd"), "us")).toEqual({ cpu: 512, memory: 1024 })
		expect(resolveCollectorTaskSize(parseMapleStage("prd"), "eu")).toEqual({ cpu: 256, memory: 1024 })
		expect(resolveCollectorTaskSize(parseMapleStage("pr-12"), "us")).toEqual({ cpu: 256, memory: 1024 })
		expect(resolveCollectorTaskSize(parseMapleStage("dev-alice"), "us")).toEqual({
			cpu: 256,
			memory: 1024,
		})
	})
})

describe("resolveIngestScaling", () => {
	it("autoscales production between the fixed count and a burst ceiling", () => {
		const regions: ReadonlyArray<MapleRegion> = ["us", "eu"]
		for (const region of regions) {
			const scaling = resolveIngestScaling(parseMapleStage("prd"), region)
			expect(scaling).toBeDefined()
			expect(scaling!.min).toBe(resolveIngestDesiredCount(parseMapleStage("prd"), region))
			expect(scaling!.max).toBeGreaterThan(scaling!.min)
			expect(scaling!.cpuUtilization).toBeGreaterThan(0)
			expect(scaling!.cpuUtilization).toBeLessThan(100)
		}
	})

	it("keeps US prd at 2-6 and sizes EU prd to its traffic at 1-3", () => {
		const policy = { cpuUtilization: 60, scaleInCooldown: "5 minutes", scaleOutCooldown: "60 seconds" }
		expect(resolveIngestScaling(parseMapleStage("prd"), "us")).toEqual({ min: 2, max: 6, ...policy })
		expect(resolveIngestScaling(parseMapleStage("prd"), "eu")).toEqual({ min: 1, max: 3, ...policy })
		expect(resolveIngestDesiredCount(parseMapleStage("prd"), "us")).toBe(2)
		expect(resolveIngestDesiredCount(parseMapleStage("prd"), "eu")).toBe(1)
	})

	it("keeps every other stage at a fixed count", () => {
		expect(resolveIngestScaling(parseMapleStage("pr-12"), "us")).toBeUndefined()
		expect(resolveIngestScaling(parseMapleStage("dev-alice"), "us")).toBeUndefined()
		expect(resolveIngestScaling(parseMapleStage("dev-alice"), "eu")).toBeUndefined()
		expect(resolveIngestDesiredCount(parseMapleStage("pr-12"), "us")).toBe(1)
	})
})

describe("EC2 fleet sizing", () => {
	it("runs US prd and previews on c7gd.large with the full-host task", () => {
		for (const stage of ["prd", "pr-12"]) {
			expect(resolveIngestEc2InstanceType(parseMapleStage(stage), "us")).toBe("c7gd.large")
			expect(resolveIngestEc2TaskSize(parseMapleStage(stage), "us")).toEqual({
				cpu: 2048,
				memory: 3072,
			})
		}
	})

	it("runs EU prd on a c7gd.medium with a task that fits its registered memory", () => {
		expect(resolveIngestEc2InstanceType(parseMapleStage("prd"), "eu")).toBe("c7gd.medium")
		expect(resolveIngestEc2TaskSize(parseMapleStage("prd"), "eu")).toEqual({ cpu: 1024, memory: 1536 })
	})

	it("keeps a non-prd EU stage on the default sizing", () => {
		expect(resolveIngestEc2InstanceType(parseMapleStage("dev-alice"), "eu")).toBe("c7gd.large")
	})
})

describe("resolveIngestSelfTraceSampleRatio", () => {
	it("samples the gateway's own traces in production only", () => {
		expect(resolveIngestSelfTraceSampleRatio(parseMapleStage("prd"))).toBe("0.05")
		expect(resolveIngestSelfTraceSampleRatio(parseMapleStage("pr-12"))).toBeUndefined()
		expect(resolveIngestSelfTraceSampleRatio(parseMapleStage("dev-alice"))).toBeUndefined()
	})
})

describe("parseIngestFleets", () => {
	const parse = (value: string | undefined) => Effect.runSync(parseIngestFleets(value))

	it("is EC2 only when unset", () => {
		expect(parse(undefined)).toEqual({ fargate: false, ec2: true })
		expect(parse("")).toEqual({ fargate: false, ec2: true })
	})

	it("can bring Fargate back beside EC2, or alone", () => {
		expect(parse("fargate, ec2")).toEqual({ fargate: true, ec2: true })
		expect(parse("fargate")).toEqual({ fargate: true, ec2: false })
	})

	it("rejects a fleet it does not know rather than deploying neither", () => {
		const error = Effect.runSync(Effect.flip(parseIngestFleets("ec2,metal")))
		expect(error._tag).toBe("@maple/infra/IngestFleetsError")
		expect(error.message).toMatch(/metal/)
	})
})

describe("resolveElectricDbPoolSize", () => {
	it("fits eu into its 25-connection cluster and leaves us on Electric's default", () => {
		expect(resolveElectricDbPoolSize("eu")).toBe(4)
		expect(resolveElectricDbPoolSize("us")).toBeUndefined()
	})
})
