import { describe, expect, it } from "vitest"
import { parseMapleStage, resolveDatabaseMode, stageDeploysSandbox } from "./stage.ts"

const stage = (name: string) => parseMapleStage(name)

describe("stageDeploysSandbox", () => {
	it("runs the agents' repository sandbox on deployed stages only", () => {
		expect(stageDeploysSandbox(stage("prd"))).toBe(true)
		expect(stageDeploysSandbox(stage("stg"))).toBe(true)
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
