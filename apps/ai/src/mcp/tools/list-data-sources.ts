import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema } from "effect"
import type { OrgId } from "@maple/domain/http"
import type { DataSourceListing } from "@maple/domain/mcp-outputs"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import * as P from "../lib/params"
import { doc, type ToolDoc } from "../lib/tool-doc"
import {
	AGENT_AUDIENCE,
	tenantWithDataSourceCatalog,
	mapDataSourceError,
	queryLanguageLabel,
} from "../lib/data-sources"
import { untrustedText } from "../lib/format"
import {
	describeDataSource,
	MAX_DESCRIBED_ENTRIES,
	renderDataSourceCatalog,
	toDataSourceSummary,
} from "./data-source-catalog"
import { MAX_SEARCH_HITS, renderDataSourceSearch, searchDataSources } from "./data-source-search"

const TOOL = "list_data_sources"
export const DATA_SOURCES_PAGE_SIZE = 50

/** A page of the org's agent-visible sources. */
const listDataSources = Effect.fn("McpTool.listDataSources")(function* (orgId: OrgId, offset: number) {
	const service = yield* ExternalDataSourceService
	const sources = yield* service.list(orgId, AGENT_AUDIENCE).pipe(mapDataSourceError(TOOL))
	if (offset > 0 && offset >= sources.length) {
		return yield* new McpInvalidInputError({
			message: `offset ${offset} is past the last data source: there are ${sources.length}. Use an offset below ${Math.max(1, sources.length)}.`,
			parameter: "offset",
		})
	}
	yield* Effect.annotateCurrentSpan({ "maple.data_source.count": sources.length })
	return {
		sources: Arr.map(sources.slice(offset, offset + DATA_SOURCES_PAGE_SIZE), toDataSourceSummary),
		total: sources.length,
		offset,
	}
})

const renderDataSourceListing = (output: typeof DataSourceListing.Type): ToolDoc => {
	if (output.total === 0) {
		return {
			title: "Data sources",
			empty: {
				message: "No data sources are connected to this organization (or none allow agent access).",
				hints: [
					"An admin connects one in Settings -> Data sources. Credentials never go through chat, so you cannot connect one here.",
				],
			},
			blocks: [],
		}
	}
	const first = output.sources[0]
	const shownEnd = output.offset + output.sources.length
	return {
		title: `Data sources (${output.total})`,
		blocks: [
			doc.table(
				["Data source", "Kind", "Query language", "Environment", "Entries", "Status", "Description"],
				Arr.map(output.sources, (s) => [
					s.name,
					s.kind,
					queryLanguageLabel(s.queryLanguage),
					s.environment,
					s.catalogTruncated ? `${s.entryCount} (capped)` : String(s.entryCount),
					s.status === "error" && s.lastError !== null
						? // The source's own error text: quoted as data, like the description.
							`error: ${untrustedText(s.lastError, 80)}`
						: s.status,
					untrustedText(s.description, 160),
				]),
			),
		],
		...(shownEnd < output.total
			? {
					truncation: {
						shown: output.sources.length,
						total: output.total,
						noun: "data sources",
						next: doc.next(TOOL, { offset: shownEnd }, "the next page of data sources"),
					},
				}
			: undefined),
		next: [
			doc.next(TOOL, { query: "orders" }, "find which data source and table hold a topic"),
			...(first === undefined
				? []
				: [doc.next(TOOL, { data_source: first.name }, "a data source's tables or resources")]),
		],
	}
}

export function registerListDataSourcesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Data Sources",
		description:
			"Everything about the external data sources this org connected for Maple to query in place: databases " +
			"(SQL) and APIs (Clerk, resource queries). Three questions, by argument. No arguments: one line per data " +
			"source with its kind, query language, environment, description, entry count and status. `query`: where a " +
			'topic lives ("failed payments", "signups"), ranked across every source\'s tables, resources, fields, ' +
			"notes and sample values, or within `data_source`. `data_source`: that source's tables or resources, " +
			`paged; add up to ${MAX_DESCRIBED_ENTRIES} \`entries\` for their fields, types, time field, PII flags, sample ` +
			"values, saved example queries and a cheat sheet for the query language. It reads stored catalogs and " +
			"never calls the source. Use it for business data that lives outside Maple (orders, payments, user " +
			"accounts), then run the query with query_data_source. Not for Maple's own traces, logs and metrics " +
			"(run_sql, describe_warehouse_tables) nor for telemetry senders (list_ingest_sources).",
		parameters: Schema.Struct({
			query: P.optionalText(
				'Words describing the data to find: table, field or topic names, e.g. "payments failed"',
			),
			data_source: P.optionalText(
				"A data source's name, e.g. shop-prod: lists its tables or resources, or narrows `query` to it",
			),
			entries: P.optionalList(
				`Tables or resources of \`data_source\` to describe in full (at most ${MAX_DESCRIBED_ENTRIES})`,
			),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 10, max: MAX_SEARCH_HITS, noun: "search hits" }),
		}),
		aliases: {
			q: "query",
			search: "query",
			source: "data_source",
			name: "data_source",
			tables: "entries",
			resources: "entries",
		},
		hints: { readOnly: true },
		permission: "telemetry:read",
		scopeFamily: "data_sources",
		phrases: ["Checking connected data sources", "Finding where the data lives", "Reading a data source"],
		handler: Effect.fn("McpTool.dataSources")(function* ({ query, data_source, entries, offset, limit }) {
			const tenant = yield* tenantWithDataSourceCatalog(TOOL)
			const asksEntries = entries !== undefined && entries.length > 0
			if (asksEntries && data_source === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"`entries` names tables or resources of one data source: pass `data_source` with it.",
					parameter: "data_source",
					example: 'data_source="shop-prod" entries=["payments"]',
				})
			}
			if (asksEntries && query !== undefined) {
				return yield* new McpInvalidInputError({
					message:
						"Pass `query` to search or `entries` to read fields, not both. Search first, then describe a hit.",
					parameter: "query",
				})
			}
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.view":
					query !== undefined ? "search" : data_source !== undefined ? "catalog" : "sources",
			})
			if (query !== undefined) {
				const search = yield* searchDataSources(tenant.orgId, {
					query,
					limit,
					...(data_source === undefined ? undefined : { dataSource: data_source }),
				})
				return { view: "search" as const, search }
			}
			if (data_source !== undefined) {
				const catalog = yield* describeDataSource(tenant.orgId, {
					dataSource: data_source,
					entries,
					offset,
				})
				return { view: "catalog" as const, catalog }
			}
			return { view: "sources" as const, listing: yield* listDataSources(tenant.orgId, offset) }
		}),
		render: (output) => {
			if (output.search !== undefined) return renderDataSourceSearch(output.search)
			if (output.catalog !== undefined) return renderDataSourceCatalog(output.catalog)
			return renderDataSourceListing(output.listing ?? { sources: [], total: 0, offset: 0 })
		},
	})
}
