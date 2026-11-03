import { expect, it } from "vitest"
import { DOCS } from "./docs"
import { Array as Arr, Record as Rec, String as Str } from "effect"

it("points every docs link at a page that exists", async () => {
	const { readdir } = await import("node:fs/promises")
	const { resolve } = await import("node:path")

	// Vitest runs with apps/web as the cwd.
	const contentRoot = resolve(process.cwd(), "../landing/src/content/docs")
	const files = await readdir(contentRoot, { recursive: true })
	const slugs = new Set(
		Arr.map(
			Arr.filter(files, (file) => /\.mdx?$/.test(file)),
			(file) => `/docs/${Str.replace(/\.mdx?$/, "")(file)}`,
		),
	)

	// Guards the guard: a wrong contentRoot would make every assertion below vacuously pass.
	expect(slugs.size).toBeGreaterThan(5)

	for (const [page, path] of Rec.toEntries(DOCS)) {
		expect(slugs.has(path), `${page} → ${path}`).toBe(true)
	}
})
