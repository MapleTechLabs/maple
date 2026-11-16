import { describe, expect, it } from "vitest"
import { GET as llmsTxt } from "../pages/llms.txt"
import { GET as pricingMd } from "../pages/pricing.md"
import { GET as compareMd } from "../pages/compare/[slug].md"
import { competitors } from "../lib/competitors"

type Context = Parameters<typeof pricingMd>[0]

const render = async (route: typeof pricingMd, props: Context["props"] = {}) => {
	const context = { site: new URL("https://maple.dev"), props } as Context
	const response = await route(context)
	return response.text()
}

const comparePages = competitors.map(
	(competitor) => [`/compare/${competitor.slug}.md`, () => render(compareMd, { competitor })] as const,
)

describe("the scale claim in the agent-readable pages", () => {
	it.each([
		["/llms.txt", () => render(llmsTxt)],
		["/pricing.md", () => render(pricingMd)],
		...comparePages,
	])("%s states the production scale and links the story absolutely", async (_, body) => {
		const text = await body()
		expect(text).toMatch(/\*\*In production:\*\* Superwall sends Maple .+ about 18 TB/)
		expect(text).toContain("](https://maple.dev/customers/superwall)")
	})
})

describe("the Enterprise offer in the agent-readable pages", () => {
	it.each([["/llms.txt", () => render(llmsTxt)], ...comparePages])(
		"%s lists SSO, SCIM and Bring Your Own Cloud and links pricing absolutely",
		async (_, body) => {
			const text = await body()
			expect(text).toMatch(
				/\*\*Enterprise:\*\* .+SSO \(SAML\/OIDC\) with SCIM provisioning.+Bring Your Own Cloud/,
			)
			expect(text).toContain("](https://maple.dev/pricing)")
		},
	)

	it("/pricing.md puts SSO and SCIM on the Enterprise plan", async () => {
		expect(await render(pricingMd)).toMatch(/Enterprise[\s\S]+SSO \(SAML\/OIDC\) with SCIM/)
	})
})
