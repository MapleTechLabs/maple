import { describe, expect, it } from "vitest"

import { ONBOARD_SKILL_COMMAND, onboardSkillPrompt } from "./onboard-skill"

describe("onboardSkillPrompt", () => {
	it("names the endpoint so an EU org's agent does not default to US ingest", () => {
		expect(onboardSkillPrompt("https://ingest.eu.maple.dev", "maple_pk_abc")).toBe(
			[
				"Install Maple in this repo using the maple-onboard skill.",
				"My ingest endpoint is https://ingest.eu.maple.dev.",
				"My public ingest key for browser and mobile code is maple_pk_abc.",
				"Server code reads my private key from MAPLE_INGEST_KEY, which I set in my environment or .env myself.",
			].join("\n"),
		)
	})

	it("drops the public key line while the key is loading, so the skill falls back to MAPLE_TEST", () => {
		const prompt = onboardSkillPrompt("https://ingest.maple.dev", "")
		expect(prompt).not.toContain("public ingest key")
		expect(prompt).toContain("MAPLE_INGEST_KEY")
	})
})

describe("ONBOARD_SKILL_COMMAND", () => {
	it("installs the skills folder, not maple-onboard alone", () => {
		// A path ending in /maple-onboard installs only that skill and drops its companions.
		expect(ONBOARD_SKILL_COMMAND).not.toMatch(/skills\/maple-onboard\b/)
		expect(ONBOARD_SKILL_COMMAND).toContain("MapleTechLabs/maple/skills --skill '*'")
	})
})
