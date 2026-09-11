import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("the API neither hosts agent execution nor imports the AI deployable", () => {
	const root = fileURLToPath(new URL("..", import.meta.url))
	for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.includes("__evals__")) continue
		const source = readFileSync(resolve(root, file), "utf8")
		const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map(
			(match) => match[1],
		)
		for (const dependency of imports) {
			expect(dependency, `${file} imports execution code`).not.toMatch(
				/@effect-agent\/(?:engine|capabilities|core)|@effect\/ai-|(?:apps|\.\.)\/ai\//,
			)
		}
	}
})
