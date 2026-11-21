import { describe, expect, it } from "vitest"
import { docsArticleLd, docsBreadcrumbLd } from "../lib/docs-structured-data"

const site = "https://maple.dev"

describe("docsBreadcrumbLd", () => {
	it("skips unlinked crumbs and ends on the page itself", () => {
		const ld = docsBreadcrumbLd(
			site,
			[
				{ name: "Docs", path: "/docs" },
				{ name: "Frontend" },
				{ name: "Effect", path: "/docs/sdks/effect" },
			],
			{ name: "Server", slug: "sdks/effect-server" },
		)
		expect(ld.itemListElement).toEqual([
			{ "@type": "ListItem", position: 1, name: "Docs", item: "https://maple.dev/docs/" },
			{ "@type": "ListItem", position: 2, name: "Effect", item: "https://maple.dev/docs/sdks/effect/" },
			{
				"@type": "ListItem",
				position: 3,
				name: "Server",
				item: "https://maple.dev/docs/sdks/effect-server/",
			},
		])
	})
})

describe("docsArticleLd", () => {
	const base = {
		site,
		slug: "frontend/nextjs",
		title: "Next.js",
		description: "Trace `fetch` calls from the browser.",
		image: "/og/docs/frontend/nextjs.jpg",
	}

	it("credits the organization when the page has no author", () => {
		const ld = docsArticleLd(base)
		expect(ld.author).toEqual(ld.publisher)
		expect(ld.url).toBe("https://maple.dev/docs/frontend/nextjs/")
		expect(ld.description).toBe("Trace fetch calls from the browser.")
		expect(ld).not.toHaveProperty("dateModified")
	})

	it("credits a named contributor as a person", () => {
		const ld = docsArticleLd({ ...base, author: { name: "JeremyFunk", github: "JeremyFunk" } })
		expect(ld.author).toEqual({
			"@type": "Person",
			name: "JeremyFunk",
			url: "https://github.com/JeremyFunk",
		})
	})
})
