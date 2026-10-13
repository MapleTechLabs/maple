import { describe, expect, it } from "vitest"
import { searchRecords, splitSections, toRecords, type SearchDoc } from "../lib/docs-search"

const doc = (
	id: string,
	title: string,
	body: string,
	rendered: { depth: number; slug: string; text: string }[],
) => {
	const { intro, sections } = splitSections(body, rendered)
	return {
		id,
		url: `/docs/${id}`,
		title,
		description: "",
		group: "Test",
		intro,
		sections,
	} satisfies SearchDoc
}

describe("splitSections", () => {
	it("uses Astro's rendered slugs and ignores headings inside any fence", () => {
		const body = [
			"Intro text.",
			"## Evaluation timing",
			"Min samples defaults to 50.",
			"````md",
			"```sh",
			"## not a heading",
			"```",
			"````",
			"~~~py",
			"## also not a heading",
			"~~~",
			"### Nested `code` heading",
			"Deeper text.",
		].join("\n")
		const { intro, sections } = splitSections(body, [
			{ depth: 2, slug: "evaluation-timing", text: "Evaluation timing" },
			{ depth: 3, slug: "nested-code-heading-1", text: "Nested code heading" },
		])
		expect(intro).toBe("Intro text.")
		expect(sections.map((s) => [s.heading, s.anchor])).toEqual([
			["Evaluation timing", "evaluation-timing"],
			["Nested code heading", "nested-code-heading-1"],
		])
		expect(sections[0].text).toContain("not a heading")
	})
})

describe("searchRecords", () => {
	const records = toRecords([
		doc(
			"alerting/alert-rules",
			"Alert rules",
			"## Evaluation timing\nMin samples 50. A check with fewer samples is skipped.",
			[{ depth: 2, slug: "evaluation-timing", text: "Evaluation timing" }],
		),
		doc(
			"integrations/prometheus",
			"Prometheus scraping",
			"## Scrape interval\nMaple scrapes every minute.",
			[{ depth: 2, slug: "scrape-interval", text: "Scrape interval" }],
		),
		doc(
			"guides/nextjs",
			"Next.js",
			"## Environment variables\nSet OTEL_EXPORTER_OTLP_HEADERS to your key.",
			[{ depth: 2, slug: "environment-variables", text: "Environment variables" }],
		),
	])

	it("requires every term as a word prefix and links the section", () => {
		const hits = searchRecords(records, "min samples")
		expect(hits.map((h) => h.record.url)).toEqual(["/docs/alerting/alert-rules#evaluation-timing"])
		expect(hits[0].snippet).toContain("Min samples")
	})

	it("matches identifiers with underscores", () => {
		const hits = searchRecords(records, "OTEL_EXPORTER_OTLP_HEADERS")
		expect(hits[0]?.record.url).toBe("/docs/guides/nextjs#environment-variables")
	})

	it("does not match inside a word", () => {
		expect(searchRecords(records, "crape")).toEqual([])
	})

	it("ranks a heading match above a body match", () => {
		const hits = searchRecords(records, "scrape")
		expect(hits[0].record.url).toBe("/docs/integrations/prometheus#scrape-interval")
	})
})
