import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { AGENT_GUIDE_CATEGORIES, AGENT_GUIDES } from "./agent-tracing-guides"

const hrefs = (id: string) => AGENT_GUIDE_CATEGORIES.find((c) => c.id === id)?.cards.map((c) => c.href)

describe("AGENT_GUIDE_CATEGORIES", () => {
	it("lists a multi-language guide under each language, opening on that language", () => {
		expect(hrefs("typescript")).toContain("/docs/agent-tracing/strands?lang=typescript")
		expect(hrefs("python")).toContain("/docs/agent-tracing/strands?lang=python")
		expect(hrefs("csharp")).toContain("/docs/agent-tracing/microsoft-agent-framework?lang=csharp")
	})

	it("links single-language guides without a language", () => {
		expect(hrefs("typescript")).toContain("/docs/agent-tracing/mastra")
		expect(hrefs("python")).not.toContain("/docs/agent-tracing/mastra")
	})

	it("lists the any-language guide only under other languages", () => {
		expect(hrefs("other")).toEqual(["/docs/agent-tracing/opentelemetry"])
		expect(hrefs("typescript")).not.toContain("/docs/agent-tracing/opentelemetry")
	})

	it("points every guide at a page", () => {
		for (const g of AGENT_GUIDES) {
			const base = new URL(`../content/docs/agent-tracing/${g.slug}`, import.meta.url).pathname
			expect(existsSync(`${base}.md`) || existsSync(`${base}.mdx`), g.slug).toBe(true)
		}
	})
})
