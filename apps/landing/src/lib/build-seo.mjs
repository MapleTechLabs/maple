/**
 * Build-time checks on the emitted HTML: internal links that would redirect, and the head facts
 * the sitemap has to agree with. Pure functions plus the Astro integration that applies them.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ANCHOR_HREF = /(<a\b[^>]*?\shref=")([^"]+)(")/g

/**
 * Adds the trailing slash to links that point at a page without one. Pages are served at
 * `/path/`, so `/path` costs a redirect on every click and every crawl.
 */
export const withTrailingSlashes = (html, isPage) =>
	html.replace(ANCHOR_HREF, (match, open, href, close) => {
		if (!href.startsWith("/") || href.startsWith("//")) return match
		const cut = href.search(/[?#]/)
		const pathname = cut === -1 ? href : href.slice(0, cut)
		if (pathname.endsWith("/") || !isPage(pathname)) return match
		return `${open}${pathname}/${cut === -1 ? "" : href.slice(cut)}${close}`
	})

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** The canonical URL, hreflang alternates and last-modified date a page declares in its head. */
export const headFacts = (html) => {
	const links = html.match(/<link\b[^>]*>/g) ?? []
	const canonical = links.map((tag) => (attr(tag, "rel") === "canonical" ? attr(tag, "href") : undefined)).find(Boolean)
	const alternates = links.flatMap((tag) => {
		const lang = attr(tag, "hreflang")
		const url = attr(tag, "href")
		return attr(tag, "rel") === "alternate" && lang && url ? [{ lang, url }] : []
	})
	const modified =
		/<meta\b[^>]*property="article:modified_time"[^>]*content="([^"]+)"/.exec(html)?.[1] ??
		/"dateModified":"([^"]+)"/.exec(html)?.[1] ??
		/<meta\b[^>]*property="article:published_time"[^>]*content="([^"]+)"/.exec(html)?.[1] ??
		/"datePublished":"([^"]+)"/.exec(html)?.[1]
	return { canonical, alternates, modified }
}

/** Reads the built page behind a sitemap URL. */
export const builtPage = (distDir, site, url) => {
	const pathname = url.startsWith(site) ? url.slice(site.length) : new URL(url).pathname
	const file = path.join(distDir, pathname, "index.html")
	return fs.existsSync(file) ? headFacts(fs.readFileSync(file, "utf8")) : undefined
}

/** A URL belongs in the sitemap when its page is its own canonical and is not an error page. */
export const sitemapIncludes = (distDir, site, url) =>
	!/\/404\/?$/.test(url) && builtPage(distDir, site, url)?.canonical === url

/**
 * A sitemap entry with the alternates and date its page declares, so the two cannot disagree.
 * A page with no date of its own gets none, not the build time.
 */
export const sitemapEntry = (distDir, site, item) => {
	const facts = builtPage(distDir, site, item.url)
	const alternates = facts?.alternates.filter((alternate) => alternate.lang !== "x-default") ?? []
	return {
		...item,
		links: alternates.length > 1 ? alternates : undefined,
		lastmod: facts?.modified ? new Date(facts.modified).toISOString() : undefined,
	}
}

const htmlFiles = (dir) =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) return htmlFiles(full)
		return entry.name.endsWith(".html") ? [full] : []
	})

/**
 * Rewrites every built page's internal links to the URL the page is served at, then fails the
 * build if the sitemap lost the home page: a filter that matches nothing must not ship quietly.
 */
export const buildSeo = ({ site }) => ({
	name: "maple:build-seo",
	hooks: {
		"astro:build:done": ({ dir }) => {
			// Asked of the output, not of the route list: locale fallback pages are written without a route.
			const dist = fileURLToPath(dir)
			const seen = new Map()
			const isPage = (pathname) => {
				if (!seen.has(pathname)) seen.set(pathname, fs.existsSync(path.join(dist, pathname, "index.html")))
				return seen.get(pathname)
			}
			for (const file of htmlFiles(dist)) {
				const html = fs.readFileSync(file, "utf8")
				const fixed = withTrailingSlashes(html, isPage)
				if (fixed !== html) fs.writeFileSync(file, fixed)
			}
			const sitemap = path.join(dist, "sitemap-0.xml")
			if (!fs.existsSync(sitemap) || !fs.readFileSync(sitemap, "utf8").includes(`<loc>${site}/</loc>`)) {
				throw new Error(`build-seo: ${sitemap} does not list ${site}/, so the sitemap filter dropped the site`)
			}
		},
	},
})
