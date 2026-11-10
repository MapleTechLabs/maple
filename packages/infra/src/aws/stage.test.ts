import { describe, expect, it } from "vitest"
import { parseMapleStage } from "../cloudflare/stage.ts"
import { REGION_INFRA } from "../region.ts"
import { resolveCollectorEndpoint, resolveIngestNamespaceName } from "./stage.ts"
import { Array as Arr, String as Str } from "effect"

/** The [first, last] IPv4 addresses a CIDR block covers, as integers. */
const cidrRange = (cidr: string): readonly [number, number] => {
	const [ip, bits = "32"] = Str.split("/")(cidr)
	const base = Arr.reduce(Str.split(".")(ip), 0, (acc, octet) => acc * 256 + Number(octet))
	const size = 2 ** (32 - Number(bits))
	const first = base - (base % size)
	return [first, first + size - 1]
}

describe("region topology", () => {
	it("maps each region to a distinct AWS region and a non-overlapping CIDR", () => {
		expect(REGION_INFRA.us.awsRegion).not.toBe(REGION_INFRA.eu.awsRegion)
		const [usFirst, usLast] = cidrRange(REGION_INFRA.us.ingestCidrBlock)
		const [euFirst, euLast] = cidrRange(REGION_INFRA.eu.ingestCidrBlock)
		expect(usLast < euFirst || euLast < usFirst).toBe(true)
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
})
