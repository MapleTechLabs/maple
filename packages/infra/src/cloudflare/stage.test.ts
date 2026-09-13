import { describe, expect, it } from "vitest"
import { parseMapleStage, resolveDatabaseMode, resolveHyperdriveRefId, stageDeploysSandbox } from "./stage.ts"

const stage = (name: string) => parseMapleStage(name)

describe("parseMapleStage", () => {
	it("rejects the removed stg stage instead of parsing it as a dev stage", () => {
		// `stg` matches the dev-stage pattern, so removing its case alone would
		// have silently produced a `maple-*-dev-stg` stack.
		expect(() => stage("stg")).toThrow(/"stg" stage was removed/)
		expect(() => stage(" STG ")).toThrow(/"stg" stage was removed/)
	})

	it("still parses the stages that remain", () => {
		expect(stage("prd")).toEqual({ kind: "prd" })
		expect(stage("pr-123")).toEqual({ kind: "pr", prNumber: 123 })
		expect(stage("dev_makisuo")).toEqual({ kind: "dev", name: "dev-makisuo" })
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
