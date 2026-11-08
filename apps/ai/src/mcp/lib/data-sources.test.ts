import { describe, expect, it } from "vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import { ExternalDataSourceId, type ExternalDataSourceDocument } from "@maple/domain/data-sources"
import { dataSourcesPromptSection, MAX_PROMPT_SOURCES } from "./data-sources"
import { dataSourcesResourceText } from "../resources/data-sources"

const source = (i: number): ExternalDataSourceDocument => ({
	id: Schema.decodeSync(ExternalDataSourceId)(
		`00000000-0000-4000-8000-${Str.padStart(12, "0")(String(i))}`,
	),
	name: `src-${i}`,
	kind: i % 2 === 0 ? "clickhouse" : "clerk",
	queryLanguage: i % 2 === 0 ? "sql:clickhouse" : "resource",
	description: `Source number ${i}`,
	environment: "production",
	tags: [],
	agentAccess: true,
	agentPii: false,
	config: { _tag: "clerk", instance: "production" },
	secretHint: null,
	status: "ok",
	lastCheckedAt: null,
	lastError: null,
	catalogRefreshedAt: null,
	catalogError: null,
	catalogEntryCount: 3,
	createdAt: 0,
	updatedAt: 0,
})

describe("dataSourcesPromptSection", () => {
	it("adds nothing for an org without data sources", () => {
		expect(dataSourcesPromptSection([])).toBeUndefined()
	})

	it("names each source with its kind, query language and environment", () => {
		const text = dataSourcesPromptSection([source(0), source(1)]) ?? ""
		expect(text).toContain("- src-0 (clickhouse, ClickHouse SQL, production): Source number 0")
		expect(text).toContain("- src-1 (clerk, resource query, production): Source number 1")
	})

	it("switches to a count and search past the cap", () => {
		const text = dataSourcesPromptSection(Arr.makeBy(MAX_PROMPT_SOURCES + 1, source)) ?? ""
		expect(text).toContain(
			`There are ${MAX_PROMPT_SOURCES + 1} data sources; use \`search_data_sources\``,
		)
		expect(text).not.toContain("src-0 (")
	})
})

describe("dataSourcesResourceText", () => {
	it("points to Settings when nothing is connected, and lists sources otherwise", () => {
		expect(dataSourcesResourceText([])).toContain("Settings -> Data sources")
		expect(dataSourcesResourceText([source(0)])).toContain(
			"- src-0 (clickhouse, ClickHouse SQL, production)",
		)
	})
})
