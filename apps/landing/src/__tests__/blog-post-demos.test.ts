import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { describe, expect, it } from "vitest"
import { Array as Arr, Option, Schema, String as Str } from "effect"

/**
 * Guards for MDX blog posts, read off disk. These catch the failure modes that only surface at
 * build time (a renamed component import) or in review (an inline SVG whose braces MDX parses as JSX).
 */

const landingRoot = resolve(__dirname, "..")
const blogDir = join(landingRoot, "content/blog")

const mdxPosts = Arr.map(
	Arr.filter(readdirSync(blogDir), (f) => Str.endsWith(".mdx")(f)),
	(f) => ({ file: f, path: join(blogDir, f), source: readFileSync(join(blogDir, f), "utf8") }),
)

const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+)"/gm

/** The frontmatter keys this guard reads; the content schema checks the rest. */
const Frontmatter = Schema.Struct({ category: Schema.optional(Schema.String) })
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

/** The post's `category`, from its YAML frontmatter (any quoting, comments, CRLF or block scalars). */
const categoryOf = (source: string): string | undefined => {
	const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1]
	if (block === undefined) return undefined
	const decoded = decodeFrontmatter(parseYaml(block))
	return Option.isSome(decoded) ? decoded.value.category : undefined
}

describe("categoryOf", () => {
	it.each([
		["double quotes", '---\ncategory: "engineering"\n---\n'],
		["no quotes and a trailing comment", "---\ncategory: engineering # deep dive\n---\n"],
		["single quotes and CRLF line endings", "---\r\ncategory: 'engineering'\r\n---\r\n"],
		["a block scalar", "---\ncategory: >-\n  engineering\n---\n"],
	])("reads %s", (_, source) => {
		expect(categoryOf(source)).toBe("engineering")
	})

	it("ignores a category that only appears in the body", () => {
		expect(categoryOf('---\ncategory: "product"\n---\n\n```yaml\ncategory: engineering\n```\n')).toBe(
			"product",
		)
	})
})

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

	// Engineering deep dives are long-form; product posts and guides can be short on purpose.
	it.runIf(categoryOf(source) === "engineering")("is long-form (body over 1500 words)", () => {
		const body = Str.replace(importRe, "")(Str.replace(/^---[\s\S]*?---/, "")(source))
		expect(Arr.filter(Str.split(/\s+/)(body), Boolean).length).toBeGreaterThan(1500)
	})

	it("keeps diagrams in components, not inline SVG", () => {
		// Inline <svg> in MDX is where literal braces ("GET /users/{id}") turn
		// into JSX expressions and break the build.
		expect(Str.includes("<svg")(source)).toBe(false)
	})
})
