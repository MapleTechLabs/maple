import { expect, it } from "vitest"
import { SIGNAL_COPY } from "./signal-empty-state"

it("points every signal at a docs page that exists", async () => {
	// Docs links rot silently — nothing in a build notices a 404. Resolving each path against the
	// landing content collection makes a renamed doc fail in the PR that renames it.
	const { readdir } = await import("node:fs/promises")
	const { resolve } = await import("node:path")

	// Vitest runs with apps/web as the cwd.
	const contentRoot = resolve(process.cwd(), "../landing/src/content/docs")
	const files = await readdir(contentRoot, { recursive: true })
	const slugs = new Set(
		files.filter((file) => /\.mdx?$/.test(file)).map((file) => `/docs/${file.replace(/\.mdx?$/, "")}`),
	)

	// Guards the guard: a wrong contentRoot would make every assertion below vacuously pass.
	expect(slugs.size).toBeGreaterThan(5)

	for (const [signal, copy] of Object.entries(SIGNAL_COPY)) {
		expect(slugs.has(copy.docs), `${signal} → ${copy.docs}`).toBe(true)
	}
})
