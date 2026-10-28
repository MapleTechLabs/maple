import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { HUB_CATEGORIES, text, tileHref } from "./integrations-hub"

const tiles = HUB_CATEGORIES.flatMap((category) => category.tiles)

describe("HUB_CATEGORIES", () => {
	it("points every tile at a docs page or landing page that exists", async () => {
		// Vitest runs with apps/landing as the cwd.
		const contentRoot = resolve(process.cwd(), "src/content/docs")
		const files = await readdir(contentRoot, { recursive: true })
		const docs = new Set(
			files
				.filter((file) => /\.mdx?$/.test(file))
				.map((file) => `/docs/${file.replace(/\.mdx?$/, "")}`),
		)
		// Guards the guard: a wrong contentRoot would make every docs assertion pass vacuously.
		expect(docs.size).toBeGreaterThan(5)

		for (const tile of tiles) {
			const path = tile.href.split("#")[0]
			const exists = path.startsWith("/docs/")
				? docs.has(path)
				: existsSync(resolve(process.cwd(), `src/pages${path}.astro`))
			expect(exists, `${text(tile.name)} → ${tile.href}`).toBe(true)
		}
	})

	it("prefixes only landing pages with the locale, since docs are English-only", () => {
		const node = tiles.find((tile) => tile.href === "/integrations/nodejs")
		const go = tiles.find((tile) => tile.href === "/docs/guides/instrumentation-go")
		expect(node && tileHref("ja", node)).toBe("/ja/integrations/nodejs")
		expect(node && tileHref("en", node)).toBe("/integrations/nodejs")
		expect(go && tileHref("ko", go)).toBe("/docs/guides/instrumentation-go")
	})

	it("ships every localized landing page in ja and ko too", () => {
		for (const tile of tiles.filter((t) => t.localized)) {
			for (const locale of ["ja", "ko"]) {
				expect(
					existsSync(resolve(process.cwd(), `src/pages/${locale}${tile.href}.astro`)),
					`${locale}${tile.href}`,
				).toBe(true)
			}
		}
	})
})
