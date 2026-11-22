import { McpInvalidInputError } from "./types"
import { Array as Arr, Effect, String as Str } from "effect"
import type { OrgId } from "@maple/domain/http"
import type { DataSourceSearch } from "@maple/domain/mcp-outputs"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { searchableWords } from "@maple/data-sources"
import { doc, type ToolDoc } from "../lib/tool-doc"
import { truncate } from "../lib/format"
import { AGENT_AUDIENCE, mapDataSourceError, queryLanguageLabel } from "../lib/data-sources"

const TOOL = "list_data_sources"

/** The most hits one search returns. */
export const MAX_SEARCH_HITS = 25

/** Search reads catalogs as agents see them, without PII sample values. */
const PII_NOTE =
	" Sample values of personal-data fields are hidden from agents unless an admin allows it, so a person's email or name is not something search can find."

/** Where a topic lives across the org's stored catalogs, or within one source. Never calls a source. */
export const searchDataSources = Effect.fn("McpTool.searchDataSources")(function* (
	orgId: OrgId,
	input: { readonly query: string; readonly limit: number; readonly dataSource?: string },
) {
	const { query, limit } = input
	const trimmed = Str.trim(query)
	if (trimmed === "") {
		return yield* new McpInvalidInputError({
			message: 'Pass the words to look for, e.g. query="payments failed".',
			parameter: "query",
		})
	}
	// Only filler words ("show me the data") would match nothing and look like a full miss.
	if (searchableWords(trimmed).length === 0) {
		return yield* new McpInvalidInputError({
			message: `"${trimmed}" has no words to search for. Name the thing itself, e.g. "invoices", "failed payments" or "signups".`,
			parameter: "query",
		})
	}
	const service = yield* ExternalDataSourceService
	// A misspelt source is answered with the closest names, not with an empty search.
	const within =
		input.dataSource === undefined
			? undefined
			: yield* service.get(orgId, input.dataSource, AGENT_AUDIENCE).pipe(mapDataSourceError(TOOL))
	const hits = yield* service
		.search(orgId, trimmed, AGENT_AUDIENCE, limit, within?.name)
		.pipe(mapDataSourceError(TOOL))
	// Only an empty answer needs to know which catalogs it could not cover.
	const sources =
		hits.length > 0 ? [] : yield* service.list(orgId, AGENT_AUDIENCE).pipe(mapDataSourceError(TOOL))
	const incompleteSources = Arr.map(
		Arr.filter(
			sources,
			(source) =>
				(within === undefined || source.name === within.name) &&
				(source.catalogError !== null ||
					source.catalogRefreshedAt === null ||
					source.catalogTruncated),
		),
		(source) => source.name,
	)
	const answer = {
		query: trimmed,
		...(within === undefined ? undefined : { dataSource: within.name }),
		hits: Arr.map(hits, (hit) => ({
			source: hit.source,
			entry: hit.entry,
			environment: hit.environment,
			queryLanguage: hit.queryLanguage,
			matchedFields: [...hit.matchedFields],
			reason: hit.reason,
			score: hit.score,
		})),
	}
	return incompleteSources.length === 0 ? answer : { ...answer, incompleteSources }
})

export const renderDataSourceSearch = (output: typeof DataSourceSearch.Type): ToolDoc => {
	const top = output.hits[0]
	if (top === undefined) {
		const incomplete = output.incompleteSources ?? []
		const within = output.dataSource
		// A miss in one source says nothing about the others: say so, and offer the wider search.
		const where = within === undefined ? "No data source table" : `No table of "${within}"`
		const cannotVouch =
			incomplete.length === 0
				? undefined
				: `search cannot vouch for ${Arr.join(incomplete, ", ")}: ${within === undefined ? "their catalog is" : "its catalog is"} incomplete (it failed, was never read, or holds more tables than Maple stores). Check ${within === undefined ? "them" : "it"} with list_data_sources data_source=<name> before concluding the data is not there.`
		return {
			title: `Data source search: "${output.query}"`,
			empty: {
				message:
					cannotVouch === undefined
						? `${where}, resource or field matches. Search matches whole words and word prefixes in every table, field, note and sample value you can see, so a different word for the same thing can miss; list_data_sources data_source=<name> lists a source's tables by name if you want to browse.${PII_NOTE}`
						: `${where}, resource or field matches, but ${cannotVouch}${PII_NOTE}`,
				hints: [
					within === undefined
						? "Try a synonym once; if that also misses, tell the user the data is not in a connected source you can see (an admin can hide sources from agents)."
						: `Only "${within}" was searched. Search every source before telling the user the data is not connected.`,
				],
			},
			blocks: [],
			next:
				within === undefined
					? [doc.next(TOOL, {}, "every connected data source")]
					: [doc.next(TOOL, { query: output.query }, "the same search across every data source")],
		}
	}
	return {
		title: `Data source search: "${output.query}"`,
		blocks: [
			doc.table(
				["Data source", "Entry", "Environment", "Query language", "Matched fields", "Why"],
				Arr.map(output.hits, (hit) => [
					hit.source,
					hit.entry,
					hit.environment,
					queryLanguageLabel(hit.queryLanguage),
					hit.matchedFields.length === 0 ? "-" : Arr.join(hit.matchedFields, ", "),
					truncate(hit.reason, 160),
				]),
			),
		],
		next: [
			doc.next(
				TOOL,
				{ data_source: top.source, entries: [top.entry] },
				"the top hit's fields, time field and how to query it",
			),
		],
	}
}
