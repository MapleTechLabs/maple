import { describe, expect, it } from "vitest"

import { agentSetupPrompt } from "./onboard-skill"
import { Array as Arr } from "effect"

describe("agentSetupPrompt", () => {
	it("points at the guide and carries the org's regional endpoint and public key", () => {
		expect(agentSetupPrompt("https://ingest.eu.maple.dev", "maple_pk_abc")).toBe(
			Arr.join(
				[
					"Set up Maple observability in this repo by following https://maple.dev/SKILL.md",
					"Ingest endpoint: https://ingest.eu.maple.dev",
					"Public ingest key: maple_pk_abc",
				],
				"\n",
			),
		)
	})

	it("leaves the key line out without one, so the guide uses its own placeholder", () => {
		expect(agentSetupPrompt("https://ingest.maple.dev", "")).not.toContain("ingest key")
	})
})
