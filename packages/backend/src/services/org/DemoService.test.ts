import { describe, expect, it } from "vitest"
import { demoSeedAllowed } from "./DemoService"

describe("demoSeedAllowed", () => {
	it("allows local stacks and PR previews only", () => {
		expect(
			["development", "pr-1290", "production", "production-eu", "pr-", "pr-12x"].map(demoSeedAllowed),
		).toEqual([true, true, false, false, false, false])
	})
})
