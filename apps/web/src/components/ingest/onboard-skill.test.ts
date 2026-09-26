import { describe, expect, it } from "vitest"

import { ONBOARD_SKILL_COMMAND, onboardSkillPrompt } from "./onboard-skill"

describe("onboardSkillPrompt", () => {
	it("names the endpoint so an EU org's agent does not default to US ingest", () => {
		expect(onboardSkillPrompt("https://ingest.eu.maple.dev", "maple_pk_abc")).toBe(
			[
				"Install Maple in this repo using the maple-onboard skill.",
				"My ingest endpoint is https://ingest.eu.maple.dev.",
				"My ingest key is maple_pk_abc.",
			].join("\n"),
		)
	})

	it("uses a placeholder while the key is loading", () => {
		expect(onboardSkillPrompt("https://ingest.maple.dev", "")).toContain(
			"My ingest key is <your-ingest-key>.",
		)
	})
})

describe("ONBOARD_SKILL_COMMAND", () => {
	it("installs the skills folder, not maple-onboard alone", () => {
		// A path ending in /maple-onboard installs only that skill and drops its companions.
		expect(ONBOARD_SKILL_COMMAND).not.toMatch(/skills\/maple-onboard\b/)
		expect(ONBOARD_SKILL_COMMAND).toContain("MapleTechLabs/maple/skills --skill '*'")
	})
})
