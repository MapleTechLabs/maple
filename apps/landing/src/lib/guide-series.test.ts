import { describe, expect, it } from "vitest"
import { guideSeries, relatedGuides, seriesPosition } from "./guide-series"
import type { GuideCategory } from "./guides"

const guide = (href: string) => ({ href, icon: "FileIcon" as const, title: href, description: "" })

const categories: GuideCategory[] = [
	{
		id: "series",
		icon: "FileIcon",
		title: "Series",
		description: "",
		// Listed out of reading order on purpose: the series decides the order.
		guides: [guide("/guides/c"), guide("/guides/a"), guide("/guides/b")],
	},
	{
		id: "other",
		icon: "FileIcon",
		title: "Other",
		description: "",
		guides: [guide("/guides/x"), guide("/guides/y"), guide("/guides/z"), guide("/guides/w")],
	},
]

const series = [{ id: "abc", title: "ABC", hrefs: ["/guides/a", "/guides/b", "/guides/c"] }]

describe("seriesPosition", () => {
	it("orders parts by the series, not by the category list", () => {
		const position = seriesPosition("/guides/b", series, categories)
		expect(position?.parts.map((part) => part.href)).toEqual(["/guides/a", "/guides/b", "/guides/c"])
		expect(position?.index).toBe(1)
	})

	it("resolves previous and next around the current part", () => {
		const middle = seriesPosition("/guides/b/", series, categories)
		expect(middle?.previous?.href).toBe("/guides/a")
		expect(middle?.next?.href).toBe("/guides/c")
	})

	it("has no previous on the first part and no next on the last", () => {
		expect(seriesPosition("/guides/a", series, categories)?.previous).toBeUndefined()
		expect(seriesPosition("/guides/c", series, categories)?.next).toBeUndefined()
		expect(seriesPosition("/guides/c", series, categories)?.previous?.href).toBe("/guides/b")
	})

	it("returns nothing for a guide outside every series", () => {
		expect(seriesPosition("/guides/x", series, categories)).toBeUndefined()
	})

	it("skips a series href that no guide lists yet", () => {
		const gappy = [{ id: "gap", title: "Gap", hrefs: ["/guides/a", "/guides/missing", "/guides/c"] }]
		const position = seriesPosition("/guides/a", gappy, categories)
		expect(position?.parts.map((part) => part.href)).toEqual(["/guides/a", "/guides/c"])
		expect(position?.next?.href).toBe("/guides/c")
	})
})

describe("relatedGuides", () => {
	it("returns other guides from the same category, without the guide itself", () => {
		expect(relatedGuides("/guides/y/", 3, categories).map((g) => g.href)).toEqual([
			"/guides/x",
			"/guides/z",
			"/guides/w",
		])
	})

	it("caps the count and returns nothing for an unknown page", () => {
		expect(relatedGuides("/guides/x", 2, categories)).toHaveLength(2)
		expect(relatedGuides("/pricing", 3, categories)).toEqual([])
	})
})

describe("the published series", () => {
	it("resolves every part to a listed guide", () => {
		for (const each of guideSeries) {
			const first = each.hrefs[0] ?? ""
			expect(seriesPosition(first)?.parts.map((part) => part.href)).toEqual(each.hrefs)
		}
	})
})
