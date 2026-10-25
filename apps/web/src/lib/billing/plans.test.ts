import { describe, expect, it } from "vitest"

import { planDisplayName, sentenceCasePlanName } from "./plans"

describe("sentenceCasePlanName", () => {
	it("lowercases title-cased words after the first", () => {
		expect(sentenceCasePlanName("Bring Your Own Cloud")).toBe("Bring your own cloud")
	})

	it("keeps brand words with inner capitals and acronyms", () => {
		expect(sentenceCasePlanName("Bring Your Own OpenRouter Key")).toBe("Bring your own OpenRouter key")
		expect(sentenceCasePlanName("Startup AI Pack")).toBe("Startup AI pack")
	})
})

describe("planDisplayName", () => {
	const catalog = [
		{ id: "startup", name: "Startup" },
		{ id: "bringyourowncloud", name: "Bring Your Own Cloud" },
	]

	it("uses the catalog name for a known id", () => {
		expect(planDisplayName("bringyourowncloud", catalog)).toBe("Bring your own cloud")
	})

	it("spaces out an unknown slug instead of capitalizing it whole", () => {
		expect(planDisplayName("legacy_pro-plan", catalog)).toBe("Legacy pro plan")
	})
})
