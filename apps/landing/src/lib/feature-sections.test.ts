import { describe, expect, it } from "vitest"
import { sectionMarkdown, UPTIME_SETUP_WAYS } from "./feature-sections"

describe("uptime-setup markdown", () => {
	it("prints the check all three ways the lede promises, each as a fenced block", () => {
		const md = sectionMarkdown("uptime-setup", new URL("https://maple.dev"))
		for (const way of UPTIME_SETUP_WAYS) {
			expect(md).toContain(`### ${way.label()}\n\n\`\`\`${way.lang}\n${way.code}\n\`\`\``)
		}
		expect(md).toContain("https://maple.dev/docs/alerting/uptime-checks")
	})
})
