import { describe, expect, it } from "vitest"
import {
	formatMapleDeployment,
	parseMapleDeployment,
	parseMapleStage,
	regionHostsSharedApps,
	resolveDatabaseMode,
	resolveHyperdriveRefId,
	resolveMapleDomains,
	resolvePlanetscaleDatabase,
	resolveStorageJurisdiction,
	resolveWorkerName,
	resolveWorkerPlacement,
	stageDeploysSandbox,
	stageMigratesDatabase,
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
		const eu = resolveMapleDomains(stage("prd"), "eu")
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
		expect(regionHostsSharedApps("eu")).toBe(false)
		expect(regionHostsSharedApps("us")).toBe(true)
	})

	it("keeps the us production hostnames exactly as they were", () => {
		expect(resolveMapleDomains(stage("prd"))).toEqual(resolveMapleDomains(stage("prd"), "us"))
		expect(resolveMapleDomains(stage("prd")).web).toBe("app.maple.dev")
		// A webhook connector's request URL is configured inside a chat platform's own app, so it
		// has to be a hostname that does not change with a deploy.
		expect(resolveMapleDomains(stage("prd")).chat).toBe("chat.maple.dev")
	})

	it("gives a PR preview no chat hostname", () => {
		expect(resolveMapleDomains(stage("pr-12")).chat).toBeUndefined()
	})

	it("has no eu hostnames for a PR preview", () => {
		expect(() => resolveMapleDomains(stage("pr-12"), "eu")).toThrow(/PR previews have no eu hostnames/)
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

describe("stageDeploysSandbox", () => {
	it("runs the agents' repository sandbox on prd, the only stage with a database", () => {
		expect(stageDeploysSandbox(stage("prd"))).toBe(true)
	})

	it("skips a PR preview, which has no database to resolve a repository with", () => {
		const preview = stage("pr-123")
		expect(stageDeploysSandbox(preview)).toBe(false)
		// The reason, pinned: a preview cannot use one even if it had it.
		expect(resolveDatabaseMode(preview)).toBe("none")
	})

	it("skips dev stages, where the container would be a multi-gigabyte local pull", () => {
		expect(stageDeploysSandbox(stage("dev_makisuo"))).toBe(false)
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

describe("resolveDatabaseMode", () => {
	it("binds the US prd's dashboard configs by id and declares the EU prd's from the deploy", () => {
		expect(resolveDatabaseMode({ kind: "prd" })).toBe("ref")
		expect(resolveDatabaseMode({ kind: "prd" }, "us")).toBe("ref")
		expect(resolveDatabaseMode({ kind: "prd" }, "eu")).toBe("declared")
		// Both prd modes adopt the branch and migrate it; neither of the others has one.
		expect(stageMigratesDatabase("ref")).toBe(true)
		expect(stageMigratesDatabase("declared")).toBe(true)
		expect(stageMigratesDatabase("managed")).toBe(false)
		expect(stageMigratesDatabase("none")).toBe(false)
	})

	it("keeps dev stages on the managed Hyperdrive in either region", () => {
		expect(resolveDatabaseMode(stage("dev_makisuo"), "eu")).toBe("managed")
	})

	it("names each instance's PlanetScale database, us unsuffixed", () => {
		expect(resolvePlanetscaleDatabase()).toBe("maple")
		expect(resolvePlanetscaleDatabase("us")).toBe("maple")
		expect(resolvePlanetscaleDatabase("eu")).toBe("maple-eu")
	})
})
