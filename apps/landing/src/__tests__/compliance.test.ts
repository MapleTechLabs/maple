import { describe, expect, it } from "vitest"
import { GET as euMd } from "../pages/eu.md"
import { GET as pricingMd } from "../pages/pricing.md"
import { GET as securityMd } from "../pages/security.md"
import { GET as llmsTxt } from "../pages/llms.txt"
import { euFaqs } from "../lib/eu-region"

const context = { site: new URL("https://maple.dev") } as Parameters<typeof euMd>[0]

describe("compliance in the .md twins", () => {
	it.each([
		["/pricing.md", pricingMd],
		["/eu.md", euMd],
		["/security.md", securityMd],
	] as const)("%s lists the DPA as available and the audits as in progress", async (_, route) => {
		const body = await (await route(context)).text()
		expect(body).toContain("## Compliance")
		expect(body).toContain("| DPA | Available |")
		expect(body).toContain("| SOC 2 Type II | In progress |")
		expect(body).toContain("| ISO 27001 | In progress |")
		expect(body).toContain("Request the DPA from [privacy@maple.dev](mailto:privacy@maple.dev).")
		expect(body).toMatch(/append-only audit log records every action .+ kept for six years/)
	})

	it("/llms.txt states the audit log and the certification status", async () => {
		const body = await (await llmsTxt(context)).text()
		expect(body).toContain("## Security and compliance")
		expect(body).toMatch(/append-only audit log records every action .+ kept for six years/)
		expect(body).toContain("SOC 2 Type II and ISO 27001 audits are in progress.")
	})

	it("points the EU certification FAQ at the DPA", () => {
		const faq = euFaqs().find((item) => item.question.includes("SOC 2"))
		expect(faq?.answer).toContain("in progress")
		expect(faq?.answer).toContain("privacy@maple.dev")
	})
})
