import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

const layerMembers = (source: string, name: string): ReadonlyArray<string> => {
	const block = new RegExp(`const ${name} = Layer\\.mergeAll\\(([\\s\\S]*?)\\n\\)`).exec(source)?.[1]
	if (block === undefined) throw new Error(`Layer ${name} was not found`)
	return block
		.split("\n")
		.map((line) => line.trim().replace(/,$/, ""))
		.filter((line) => line !== "")
}

describe("API runtime graph boundaries", () => {
	it("keeps the service composition root free of HTTP routes and schemas", () => {
		const imports = importSpecifiers(readModule("./service-graph.ts"))

		expect(imports.filter((specifier) => specifier.includes("/routes/"))).toEqual([])
		expect(imports.filter((specifier) => specifier.startsWith("@maple/domain/http"))).toEqual([])
		expect(imports.filter((specifier) => specifier.startsWith("effect/unstable/http"))).toEqual([])
	})

	it("keeps the HTTP entrypoint off the compatibility facade", () => {
		const source = readModule("../worker/http.ts")

		expect(importSpecifiers(source)).toContain("../runtime/service-graph")
		expect(importSpecifiers(source).some((specifier) => /(?:^|\/)app$/.test(specifier))).toBe(false)
		expect(source).toContain("HttpServicesLive")
		expect(source).not.toMatch(/\{\s*MainLive\s*\}/)
	})
})
