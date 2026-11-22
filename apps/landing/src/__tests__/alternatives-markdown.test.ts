import { describe, expect, it } from "vitest"
import { GET as alternativesMd } from "../pages/alternatives/[slug].md"
import { alternativesPages } from "../lib/alternatives"

type Context = Parameters<typeof alternativesMd>[0]

const render = async (slug: string) => {
	const page = alternativesPages.find((candidate) => candidate.slug === slug)
	if (!page) throw new Error(`no alternatives page ${slug}`)
	const context = { site: new URL("https://maple.dev"), props: { page } } as Context
	return (await alternativesMd(context)).text()
}

describe("alternatives markdown twins", () => {
	it.each(alternativesPages.map((page) => [page.slug, page] as const))(
		"%s heads its table with the page's key column and labels Maple as ours",
		async (slug, page) => {
			const text = await render(slug)
			expect(text).toContain(`| Tool | Pick it if | Pricing | License | ${page.keyColumn} |`)
			expect(text).toContain("| Maple (ours) |")
			expect(text).toContain("https://maple.dev/pricing")
		},
	)
})
