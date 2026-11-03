import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { Array as Arr, String as Str } from "effect"

/**
 * Source-level guards for MDX blog posts and their demo components, in the
 * same read-off-disk style as company-pages.test.ts. These catch the failure
 * modes that only surface at build time (a renamed component import) or in
 * review (an inline SVG whose braces MDX parses as JSX expressions).
 */

const landingRoot = resolve(__dirname, "..")
const blogDir = join(landingRoot, "content/blog")
const demosDir = join(landingRoot, "components/blog/demos")

const mdxPosts = Arr.map(
	Arr.filter(readdirSync(blogDir), (f) => Str.endsWith(".mdx")(f)),
	(f) => ({ file: f, path: join(blogDir, f), source: readFileSync(join(blogDir, f), "utf8") }),
)

const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+)"/gm

describe.each(mdxPosts)("blog post $file", ({ path, source }) => {
	const imports = Arr.map(Array.from(source.matchAll(importRe)), (m) => ({
		identifier: m[1],
		specifier: m[2],
	}))

	it("resolves every relative component import", () => {
		for (const { specifier } of imports) {
			expect(existsSync(resolve(dirname(path), specifier)), `missing: ${specifier}`).toBe(true)
		}
	})

	it("embeds every imported component at least once", () => {
		for (const { identifier } of imports) {
			expect(Str.includes(`<${identifier}`)(source), `unused import: ${identifier}`).toBe(true)
		}
	})

	it("is long-form (body over 1500 words)", () => {
		const body = Str.replace(importRe, "")(Str.replace(/^---[\s\S]*?---/, "")(source))
		expect(Arr.filter(Str.split(/\s+/)(body), Boolean).length).toBeGreaterThan(1500)
	})

	it("keeps diagrams in components, not inline SVG", () => {
		// Inline <svg> in MDX is where literal braces ("GET /users/{id}") turn
		// into JSX expressions and break the build.
		expect(Str.includes("<svg")(source)).toBe(false)
	})
})

describe("blog demo components", () => {
	const demos = existsSync(demosDir)
		? Arr.filter(readdirSync(demosDir), (f) => Str.endsWith(".astro")(f))
		: []

	it.each(demos)("%s guards its animations behind prefers-reduced-motion", (file) => {
		const source = readFileSync(join(demosDir, file), "utf8")
		if (Str.includes("@keyframes")(source)) {
			expect(source).toContain("prefers-reduced-motion")
		}
	})
})
