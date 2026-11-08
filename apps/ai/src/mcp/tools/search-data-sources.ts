import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema, String as Str } from "effect"
import { SearchDataSourcesOutput } from "@maple/domain/mcp-outputs"
import {
	ExternalDataSourceService,
	MAX_CATALOG_ENTRIES,
} from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { searchableWords } from "@maple/data-sources"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { truncate } from "../lib/format"
import { AGENT_AUDIENCE, mapDataSourceError, queryLanguageLabel } from "../lib/data-sources"

const TOOL = "search_data_sources"

export function registerSearchDataSourcesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Search Data Sources",
		description:
			"Find where data lives across every connected data source (external databases and APIs), ranked: matches " +
			"table, resource and field names, notes and sample values, and prefers production over staging copies. " +
			"Each hit names the data source, the table or resource, the fields that matched, why, its environment and " +
			'query language. Use it first when the user names a topic ("failed payments", "signups") rather than a ' +
			"data source. It reads stored catalogs, so it never calls the source. Not for Maple's own telemetry: use " +
			"run_sql, query_data or the traces and logs tools for that. Next: describe_data_source on a hit.",
		parameters: Schema.Struct({
			query: P.text('Words describing the data: table, field or topic names, e.g. "payments failed"'),
			limit: P.limit({ default: 10, max: 25, noun: "hits" }),
		}),
		aliases: { q: "query", search: "query" },
		output: SearchDataSourcesOutput,
		hints: { readOnly: true },
		phrases: ["Searching data sources", "Finding where the data lives"],
		handler: Effect.fn("McpTool.searchDataSources")(function* ({ query, limit }) {
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
			const tenant = yield* CurrentMcpTenant
			const service = yield* ExternalDataSourceService
			const hits = yield* service
				.search(tenant.orgId, trimmed, AGENT_AUDIENCE, limit)
				.pipe(mapDataSourceError(TOOL))
			// Only an empty answer needs to know which catalogs it could not cover.
			const sources =
				hits.length > 0
					? []
					: yield* service.list(tenant.orgId, AGENT_AUDIENCE).pipe(mapDataSourceError(TOOL))
			const incompleteSources = Arr.map(
				Arr.filter(
					sources,
					(source) =>
						source.catalogError !== null ||
						source.catalogRefreshedAt === null ||
						source.catalogEntryCount >= MAX_CATALOG_ENTRIES,
				),
				(source) => source.name,
			)
			const answer = {
				query: trimmed,
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
		}),
		render: (output) => {
			const top = output.hits[0]
			if (top === undefined) {
				const incomplete = output.incompleteSources ?? []
				return {
					title: `Data source search: "${output.query}"`,
					empty: {
						message:
							incomplete.length === 0
								? "No data source table, resource or field matches. Search covers every table, field, note and sample value of every data source you can see, so paging describe_data_source will not find more."
								: `No data source table, resource or field matches, but search cannot vouch for ${Arr.join(incomplete, ", ")}: their catalog is incomplete (it failed, was never read, or holds more tables than Maple stores). Check them with describe_data_source before concluding the data is not there.`,
						hints: [
							"Try a synonym once; if that also misses, tell the user the data is not in a connected source you can see (an admin can hide sources from agents).",
						],
					},
					blocks: [],
					next: [doc.next("list_data_sources", {}, "every connected data source")],
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
						"describe_data_source",
						{ data_source: top.source, entries: [top.entry] },
						"the top hit's fields, time field and how to query it",
					),
				],
			}
		},
	})
}
