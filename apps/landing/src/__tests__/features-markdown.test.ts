import { describe, expect, it } from "vitest"
import { featuresMarkdown } from "../pages/features.md"
import { features } from "../lib/features"
import { PILLARS } from "../lib/feature-pillars"
import { Array as Arr } from "effect"

describe("/features.md", () => {
	const text = featuresMarkdown(new URL("https://maple.dev"))
	const links = Arr.map(
		[...text.matchAll(/\]\(https:\/\/maple\.dev\/features\/([a-z0-9-]+)\.md\)/g)],
		(match) => match[1],
	)

	it("lists every feature exactly once", () => {
		expect([...links].sort()).toEqual(Arr.map(features, (feature) => feature.slug).sort())
	})

	it("leads with the pillars, in their order", () => {
		expect(links.slice(0, PILLARS.length)).toEqual(Arr.map(PILLARS, (pillar) => pillar.slug))
	})
})
