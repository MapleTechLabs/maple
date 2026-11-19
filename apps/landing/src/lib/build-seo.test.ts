import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { headFacts, sitemapEntry, sitemapIncludes, withTrailingSlashes } from "./build-seo.mjs"

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

describe("the sitemap", () => {
	const site = "https://maple.dev"
	const page = (dist: string, pathname: string, head: string) => {
		fs.mkdirSync(path.join(dist, pathname), { recursive: true })
		fs.writeFileSync(path.join(dist, pathname, "index.html"), `<html><head>${head}</head></html>`)
	}
	const built = () => {
		const dist = fs.mkdtempSync(path.join(os.tmpdir(), "build-seo-"))
		page(
			dist,
			"pricing",
			'<link rel="canonical" href="https://maple.dev/pricing/"><link rel="alternate" hreflang="en" href="https://maple.dev/pricing/"><link rel="alternate" hreflang="ja" href="https://maple.dev/ja/pricing/"><link rel="alternate" hreflang="x-default" href="https://maple.dev/pricing/">',
		)
		page(
			dist,
			"blog/post",
			'<link rel="canonical" href="https://maple.dev/blog/post/"><link rel="alternate" hreflang="en" href="https://maple.dev/blog/post/"><meta property="article:modified_time" content="2026-11-01">',
		)
		// A locale URL that falls back to English, and an error page that is its own canonical.
		page(dist, "ja/about", '<link rel="canonical" href="https://maple.dev/about/">')
		page(dist, "ja/404", '<link rel="canonical" href="https://maple.dev/ja/404/">')
		return dist
	}

	it("lists a page that is its own canonical, and not a fallback copy, an error page or a missing page", () => {
		const dist = built()
		expect(sitemapIncludes(dist, site, "https://maple.dev/pricing/")).toBe(true)
		expect(sitemapIncludes(dist, site, "https://maple.dev/ja/about/")).toBe(false)
		expect(sitemapIncludes(dist, site, "https://maple.dev/ja/404/")).toBe(false)
		expect(sitemapIncludes(dist, site, "https://maple.dev/not-built/")).toBe(false)
	})

	it("gives an entry the alternates its page declares, and a date only when the page has one", () => {
		const dist = built()
		expect(sitemapEntry(dist, site, { url: "https://maple.dev/pricing/" })).toEqual({
			url: "https://maple.dev/pricing/",
			links: [
				{ lang: "en", url: "https://maple.dev/pricing/" },
				{ lang: "ja", url: "https://maple.dev/ja/pricing/" },
			],
			lastmod: undefined,
		})
		expect(sitemapEntry(dist, site, { url: "https://maple.dev/blog/post/" })).toEqual({
			url: "https://maple.dev/blog/post/",
			links: undefined,
			lastmod: "2026-11-01T00:00:00.000Z",
		})
	})
})
