import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
	formatMapleDeployment,
	MapleStageError,
	parseMapleDeployment,
	parseMapleDeploymentEffect,
	parseMapleStage,
	resolveHyperdriveRefId,
	resolveMapleDomains,
	resolvePlanetscaleDatabase,
	resolveRegionAppUrls,
	resolveStorageJurisdiction,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "./stage.ts"

const stage = (name: string) => parseMapleStage(name)

describe("parseMapleStage", () => {
	it("rejects the removed stg stage instead of parsing it as a dev stage", () => {
		// `stg` matches the dev-stage pattern, so removing its case alone would
		// have silently produced a `maple-*-dev-stg` stack.
		expect(() => stage("stg")).toThrow(/"stg" stage was removed/)
		expect(() => stage(" STG ")).toThrow(/"stg" stage was removed/)
	})

	it("rejects the spellings someone types from memory, which match the same pattern", () => {
		expect(() => stage("staging")).toThrow(/"staging" stage was removed/)
		expect(() => stage("Staging")).toThrow(/"staging" stage was removed/)
		expect(() => stage("stage")).toThrow(/"stage" stage was removed/)
	})

	it("still parses the stages that remain", () => {
		expect(stage("prd")).toEqual({ kind: "prd" })
		expect(stage("pr-123")).toEqual({ kind: "pr", prNumber: 123 })
		expect(stage("dev_makisuo")).toEqual({ kind: "dev", name: "dev-makisuo" })
	})
})

describe("parseMapleDeployment", () => {
	it("reads the region off the stage string, defaulting to us", () => {
		expect(parseMapleDeployment("prd")).toEqual({ stage: { kind: "prd" }, region: "us" })
		expect(parseMapleDeployment("prd-eu")).toEqual({ stage: { kind: "prd" }, region: "eu" })
		expect(parseMapleDeployment(" PRD-EU ")).toEqual({ stage: { kind: "prd" }, region: "eu" })
		expect(parseMapleDeployment("dev_makisuo-eu")).toEqual({
			stage: { kind: "dev", name: "dev-makisuo" },
			region: "eu",
		})
	})

	it("keeps PR previews on the us instance", () => {
		expect(parseMapleDeployment("pr-12")).toEqual({ stage: { kind: "pr", prNumber: 12 }, region: "us" })
		expect(() => parseMapleDeployment("pr-12-eu")).toThrow(/PR previews deploy to the us instance/)
	})

	it("round-trips through formatMapleDeployment, which is what the deploy summary prints", () => {
		for (const raw of ["prd", "prd-eu", "pr-12", "dev-makisuo", "dev-makisuo-eu"]) {
			expect(formatMapleDeployment(parseMapleDeployment(raw))).toBe(raw)
		}
	})

	it("still rejects the removed stg stage under either region", () => {
		expect(() => parseMapleDeployment("stg-eu")).toThrow(/"stg" stage was removed/)
	})

	it("fails the Effect variant with a typed MapleStageError instead of throwing", () => {
		const error = Effect.runSync(Effect.flip(parseMapleDeploymentEffect("pr-12-eu")))
		expect(error).toBeInstanceOf(MapleStageError)
		expect(error.rawStage).toBe("pr-12-eu")
	})
})

describe("resolveWorkerName", () => {
	it("leaves us unsuffixed so the existing prd Workers keep their names", () => {
		expect(resolveWorkerName("api", stage("prd"))).toBe("maple-api")
		expect(resolveWorkerName("api", stage("prd"), "us")).toBe("maple-api")
		expect(resolveWorkerName("api", stage("pr-12"), "us")).toBe("maple-api-pr-12")
	})

	it("suffixes eu right after the base, mirroring the AWS names", () => {
		expect(resolveWorkerName("api", stage("prd"), "eu")).toBe("maple-api-eu")
		expect(resolveWorkerName("db", stage("dev_makisuo"), "eu")).toBe("maple-db-eu-dev-dev-makisuo")
	})
})

describe("resolveMapleDomains", () => {
	it("gives the EU instance its own hostnames under eu.maple.dev, and no shared apps", () => {
		const eu = resolveMapleDomains({ stage: stage("prd"), region: "eu" })
		expect(eu).toEqual({
			web: "app.eu.maple.dev",
			api: "api.eu.maple.dev",
			ingest: "ingest.eu.maple.dev",
			sync: "sync.eu.maple.dev",
			electric: "electric.eu.maple.dev",
			chat: "chat.eu.maple.dev",
		})
		expect(eu.landing).toBeUndefined()
		expect(eu.local).toBeUndefined()
	})

	it("keeps the us production hostnames exactly as they were", () => {
		// `chat` especially: a chat platform's app stores the webhook URL, so it must never move.
		expect(resolveMapleDomains({ stage: stage("prd"), region: "us" })).toEqual({
			web: "app.maple.dev",
			api: "api.maple.dev",
			ingest: "ingest.maple.dev",
			sync: "sync.maple.dev",
			electric: "electric.maple.dev",
			landing: "maple.dev",
			local: "local.maple.dev",
			chat: "chat.maple.dev",
		})
	})

	it("gives a PR preview outside us no hostnames rather than the us ones", () => {
		expect(resolveMapleDomains({ stage: stage("pr-12"), region: "eu" })).toEqual({})
	})

	it("gives a PR preview no chat hostname", () => {
		expect(resolveMapleDomains({ stage: stage("pr-12"), region: "us" }).chat).toBeUndefined()
	})

	it("lists every region's dashboard on prd only", () => {
		expect(resolveRegionAppUrls(stage("prd"))).toEqual({
			us: "https://app.maple.dev",
			eu: "https://app.eu.maple.dev",
		})
		expect(resolveRegionAppUrls(stage("pr-12"))).toEqual({})
		expect(resolveRegionAppUrls(stage("david"))).toEqual({})
	})
})

describe("region-bound Cloudflare settings", () => {
	it("steers each instance's Workers beside its own database and warehouse", () => {
		expect(resolveWorkerPlacement("us")).toEqual({ region: "aws:us-east-1" })
		expect(resolveWorkerPlacement("eu")).toEqual({ region: "aws:eu-central-1" })
		expect(resolveWorkerPlacement()).toEqual({ region: "aws:us-east-1" })
	})

	it("pins EU storage to the eu jurisdiction and leaves us non-jurisdictional", () => {
		expect(resolveStorageJurisdiction("eu")).toBe("eu")
		expect(resolveStorageJurisdiction("us")).toBeUndefined()
	})
})

describe("resolveHyperdriveRefId", () => {
	it("hands the production configs to prd and to nothing else", () => {
		// These ids are the live dashboard configs for the production database.
		// `stg` used to be handed `maple-prd` too, which is why the stage is gone.
		expect(resolveHyperdriveRefId({ kind: "prd" }, "api")).toBe("ad4c487838594b89810b23e5fb14e129")
		expect(resolveHyperdriveRefId({ kind: "prd" }, "ai")).toBe("ad4c487838594b89810b23e5fb14e129")
		expect(resolveHyperdriveRefId({ kind: "prd" }, "alerting")).toBe("f473167201af4d2cae494f9989f1d742")
		expect(resolveHyperdriveRefId(stage("pr-123"), "api")).toBeUndefined()
		expect(resolveHyperdriveRefId(stage("dev_makisuo"), "api")).toBeUndefined()
	})
})

describe("resolvePlanetscaleDatabase", () => {
	it("names each instance's PlanetScale database, us unsuffixed", () => {
		expect(resolvePlanetscaleDatabase()).toBe("maple")
		expect(resolvePlanetscaleDatabase("us")).toBe("maple")
		expect(resolvePlanetscaleDatabase("eu")).toBe("maple-eu")
	})
})
