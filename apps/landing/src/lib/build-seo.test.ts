import { describe, expect, it } from "vitest"
import { headFacts, withTrailingSlashes } from "./build-seo.mjs"

const pages = new Set(["/pricing", "/features/alerts", "/ja/pricing"])
const isPage = (pathname: string) => pages.has(pathname)

describe("withTrailingSlashes", () => {
	it("adds the slash to a link that points at a page, keeping its query and fragment", () => {
		const html = '<a class="x" href="/pricing">a</a><a href="/features/alerts#rules">b</a><a href="/ja/pricing?plan=startup">c</a>'
		expect(withTrailingSlashes(html, isPage)).toBe(
			'<a class="x" href="/pricing/">a</a><a href="/features/alerts/#rules">b</a><a href="/ja/pricing/?plan=startup">c</a>',
		)
	})

	it("leaves files, other sites, in-page anchors and already-correct links alone", () => {
		const html =
			'<a href="/cli/install">a</a><a href="/pricing/">b</a><a href="//cdn.example.com/pricing">c</a><a href="https://maple.dev/pricing">d</a><a href="#top">e</a><a href="/#features">f</a>'
		expect(withTrailingSlashes(html, isPage)).toBe(html)
	})

	it("does not touch stylesheet or icon links", () => {
		const html = '<link rel="alternate" href="/pricing"><a href="/pricing">a</a>'
		expect(withTrailingSlashes(html, isPage)).toBe('<link rel="alternate" href="/pricing"><a href="/pricing/">a</a>')
	})
})

describe("headFacts", () => {
	it("reads the canonical, the hreflang alternates and the modified date", () => {
		const html =
			'<link rel="canonical" href="https://maple.dev/pricing/"><link rel="alternate" hreflang="en" href="https://maple.dev/pricing/"><link rel="alternate" hreflang="ja" href="https://maple.dev/ja/pricing/"><link rel="alternate" type="text/markdown" href="https://maple.dev/pricing.md"><script type="application/ld+json">{"@type":"Article","dateModified":"2026-11-01"}</script>'
		expect(headFacts(html)).toEqual({
			canonical: "https://maple.dev/pricing/",
			alternates: [
				{ lang: "en", url: "https://maple.dev/pricing/" },
				{ lang: "ja", url: "https://maple.dev/ja/pricing/" },
			],
			modified: "2026-11-01",
		})
	})

	it("reports no date for a page that declares none", () => {
		expect(headFacts('<link rel="canonical" href="https://maple.dev/eu/">').modified).toBeUndefined()
	})
})
