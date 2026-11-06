import { describe, expect, it } from "vitest"
import { demoSeedAllowed } from "./DemoService"
import { Array as Arr } from "effect"

describe("demoSeedAllowed", () => {
	it("allows local stacks and PR previews only", () => {
		expect(
			Arr.map(
				["development", "pr-1290", "production", "production-eu", "pr-", "pr-12x"],
				demoSeedAllowed,
			),
		).toEqual([true, true, false, false, false, false])
	})
})
