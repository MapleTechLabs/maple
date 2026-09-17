import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readModule = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const importSpecifiers = (source: string): ReadonlyArray<string> =>
	Array.from(source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g), (match) => match[1]!)

describe("AI runtime graph boundaries", () => {
	it("keeps runtime entrypoints off the compatibility facade", () => {
		const runtimeEntrypoints: ReadonlyArray<
			readonly [
				source: string,
				expectedImports: ReadonlyArray<string>,
				expectedRoots: ReadonlyArray<string>,
			]
		> = [
			[
				readModule("../chat/turn-runner.ts"),
				["../runtime/mcp-service-graph"],
				["InvestigationServicesLive"],
			],
			[
				readModule("../mcp/__evals__/eval-runtime.ts"),
				["../../runtime/mcp-service-graph"],
				["McpServicesLive"],
			],
		]

		for (const [source, expectedImports, expectedRoots] of runtimeEntrypoints) {
			for (const expectedImport of expectedImports)
				expect(importSpecifiers(source)).toContain(expectedImport)
			expect(importSpecifiers(source).some((specifier) => /(?:^|\/)app$/.test(specifier))).toBe(false)
			for (const root of expectedRoots) expect(source).toContain(root)
			expect(source).not.toMatch(/\{\s*MainLive\s*\}/)
		}
	})

	it("keeps the headless MCP root limited to registered tool requirements", () => {
		const source = readModule("../mcp/dispatcher.ts")
		const imports = importSpecifiers(source)

		expect(imports).not.toContain("./service-graph")
		for (const routeOnlyService of [
			"DailySpendService",
			"CloudflareAnalyticsService",
			"AnomalyDetectionService",
			"AiTriageService",
			"DigestService",
			"DemoService",
			"SlackIntegrationService",
		]) {
			expect(imports.some((specifier) => specifier.endsWith(`/${routeOnlyService}`))).toBe(false)
		}
	})
})
