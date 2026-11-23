import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri"
import { describe, expect, it } from "vitest"
import { tableWrapPlugin } from "./rehype-table-wrap.mjs"
import { installTabsPlugin } from "./remark-install-tabs.mjs"

const DOCS = new URL("file:///repo/apps/landing/src/content/docs/sdks/node.md")
const BLOG = new URL("file:///repo/apps/landing/src/content/blog/launch.md")

const render = async (markdown: string, fileURL: URL) => {
	const processor = await createSatteriMarkdownProcessor({
		syntaxHighlight: false,
		mdastPlugins: [installTabsPlugin],
		hastPlugins: [tableWrapPlugin],
	})
	const { code } = await processor.render(markdown, { fileURL })
	return code
}

const INSTALL = "```bash\nnpm install @maple-dev/node\n```\n"
const TABLE = "| Flag | Meaning |\n|---|---|\n| `-y` | Skip the prompt |\n"

describe("Sätteri markdown plugins", () => {
	it("turns a docs install block into a tab per package manager", async () => {
		const html = await render(INSTALL, DOCS)
		expect(html).toContain('data-lang-tabs="maple-docs-js-package-manager"')
		expect(html.match(/data-lang-trigger="(\w+)"/g)).toEqual([
			'data-lang-trigger="npm"',
			'data-lang-trigger="pnpm"',
			'data-lang-trigger="bun"',
		])
		expect(html).toContain("pnpm add @maple-dev/node")
		expect(html).toContain("bun add @maple-dev/node")
	})

	it("leaves install blocks outside the docs as one block", async () => {
		const html = await render(INSTALL, BLOG)
		expect(html).not.toContain("data-lang-tabs")
		expect(html).toContain("npm install @maple-dev/node")
	})

	it("wraps tables everywhere and marks short code only in the docs", async () => {
		const docs = await render(TABLE, DOCS)
		const blog = await render(TABLE, BLOG)
		expect(docs).toMatch(/<div class="table-wrap"><table>/)
		expect(blog).toMatch(/<div class="table-wrap"><table>/)
		expect(docs).toContain('<code class="nw">-y</code>')
		expect(blog).not.toContain('class="nw"')
	})
})
