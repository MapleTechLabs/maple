import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { GUIDE_SECTIONS } from "./instrumentation-guides"
import { HUB_CATEGORIES, text, tileHref } from "./integrations-hub"
import { integrations } from "./integrations"
import { Array as Arr, String as Str } from "effect"

const tiles = Arr.flatMap(HUB_CATEGORIES, (category) => category.tiles)

describe("HUB_CATEGORIES", () => {
	it("points every tile at a docs page or landing page that exists", async () => {
		// Vitest runs with apps/landing as the cwd.
		const contentRoot = resolve(process.cwd(), "src/content/docs")
		const files = await readdir(contentRoot, { recursive: true })
		const docs = new Set(
			Arr.map(
				Arr.filter(files, (file) => /\.mdx?$/.test(file)),
				(file) => `/docs/${Str.replace(/\.mdx?$/, "")(file)}`,
			),
		)
		// Guards the guard: a wrong contentRoot would make every docs assertion pass vacuously.
		expect(docs.size).toBeGreaterThan(5)

		for (const tile of tiles) {
			const path = Str.split("#")(tile.href)[0]
			const exists = Str.startsWith("/docs/")(path)
				? docs.has(path)
				: existsSync(resolve(process.cwd(), `src/pages${path}.astro`))
			expect(exists, `${text(tile.name)} → ${tile.href}`).toBe(true)
		}
	})

	it("prefixes only landing pages with the locale, since docs are English-only", () => {
		const node = tiles.find((tile) => tile.href === "/integrations/nodejs")
		const kotlin = tiles.find((tile) => tile.href === "/docs/guides/instrumentation-kotlin")
		expect(node && tileHref("ja", node)).toBe("/ja/integrations/nodejs")
		expect(node && tileHref("en", node)).toBe("/integrations/nodejs")
		expect(kotlin && tileHref("ko", kotlin)).toBe("/docs/guides/instrumentation-kotlin")
	})

	it("opens a guide's integration page instead of the guide, when it has one", () => {
		const go = tiles.find((tile) => text(tile.name) === "Go")
		const langchain = tiles.find((tile) => text(tile.name) === "LangChain & LangGraph")
		expect(go?.href).toBe("/integrations/go")
		expect(langchain?.href).toBe("/integrations/langchain")
		// English-only pages keep their English URL from /ja and /ko.
		expect(go && tileHref("ja", go)).toBe("/integrations/go")
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

	it("covers every page the instrumentation index links to", () => {
		const hub = new Set(Arr.map(tiles, (tile) => Str.split("#")(tile.href)[0]))
		// Pages the hub reaches another way, or leaves out on purpose.
		const elsewhere = new Set([
			// Guides with an /integrations page are reached through it, when the hub offers that page.
			...Arr.flatMap(Object.values(integrations), (i) =>
				hub.has(`/integrations/${i.slug}`) ? [i.docsHref] : [],
			),
			// One Effect tile stands for the SDK's runtime-specific pages.
			"/docs/sdks/effect-cloudflare",
			"/docs/sdks/effect-client",
			"/docs/sdks/effect-foldkit",
			// The framework tiles stand for the frontend overview.
			"/docs/frontend",
			// An API, not an integration.
			"/docs/product-events/api",
		])
		const pages = Arr.flatMap(GUIDE_SECTIONS, (section) =>
			Arr.map(section.cards, (card) => Str.split("#")(card.href)[0]),
		)
		// In-page anchors on /docs/instrumentation split to "".
		const missing = Arr.filter(pages, (page) => page !== "" && !hub.has(page) && !elsewhere.has(page))
		expect(missing).toEqual([])
	})
})
