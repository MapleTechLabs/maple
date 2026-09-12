import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

/**
 * The MCP half of `AlertReadModelsService`'s boundary, which lived beside the
 * service until the tools moved Workers. It is kept because the distinction is
 * easy to lose: a read handler that reaches for `AlertsService` pulls the whole
 * evaluation and dispatch graph in behind it, and these tools only ever read.
 */
describe("alert read tools", () => {
	it("read through AlertReadModelsService, never AlertsService", () => {
		for (const path of [
			"./list-alert-incidents.ts",
			"./get-incident-timeline.ts",
			"./list-alert-checks.ts",
		]) {
			const imports = importSpecifiers(readModule(path))
			expect(imports).toContain("@/services/alerts/AlertReadModelsService")
			expect(imports).not.toContain("@/services/alerts/AlertsService")
		}
	})
})
