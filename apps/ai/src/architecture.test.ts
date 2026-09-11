import { readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "vitest"

const aiRoot = dirname(fileURLToPath(import.meta.url))
const srcRoot = aiRoot

/** Enforce ownership on static imports, re-exports and dynamic imports, including relative paths. */
const imports = (path: string) => {
	const source = readFileSync(path, "utf8")
	return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)]
		.map((match) => match[1]!)
		.flatMap((specifier) => {
			if (specifier.startsWith("@/")) return [specifier.slice(2)]
			if (specifier.startsWith(".")) return [relative(srcRoot, resolve(dirname(path), specifier))]
			return []
		})
}

describe("AI module ownership", () => {
	for (const owner of ["runtime", "assistant", "investigations"] as const) {
		it(`${owner} has no dependencies on channels, workflow hosts or sibling features`, () => {
			const directory = resolve(aiRoot, owner)
			const sources = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(
				(name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes("__evals__/"),
			)
			assert.isNotEmpty(sources)
			for (const name of sources) {
				for (const dependency of imports(resolve(directory, name))) {
					const allowedAi = dependency.startsWith(`${owner}/`) || dependency.startsWith("runtime/")
					const forbidden =
						dependency.startsWith("chat/") ||
						dependency.startsWith("workflows/") ||
						dependency.startsWith("routes/") ||
						(!allowedAi &&
							["assistant/", "investigations/"].some((feature) =>
								dependency.startsWith(feature),
							)) ||
						dependency.includes("api/")
					assert.isFalse(forbidden, `${owner}/${name} imports ${dependency}`)
				}
			}
		})
	}
})

it("execution has no imports from the API or its product storage", () => {
	for (const name of readdirSync(aiRoot, { recursive: true, encoding: "utf8" })) {
		if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
		const source = readFileSync(resolve(aiRoot, name), "utf8")
		for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
			assert.notMatch(match[1]!, /@maple\/(?:api|db|query-engine)(?:["/]|$)|(?:apps|\.\.)\/api\//, name)
		}
	}
})
