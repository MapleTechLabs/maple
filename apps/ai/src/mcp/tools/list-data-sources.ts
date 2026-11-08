import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema } from "effect"
import { ListDataSourcesOutput } from "@maple/domain/mcp-outputs"
import type { ExternalDataSourceDocument } from "@maple/domain/data-sources"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { AGENT_AUDIENCE, mapDataSourceError, queryLanguageLabel, untrustedText } from "../lib/data-sources"

const TOOL = "list_data_sources"
export const DATA_SOURCES_PAGE_SIZE = 50

export const toDataSourceSummary = (source: ExternalDataSourceDocument) => ({
	name: source.name,
	kind: source.kind,
	queryLanguage: source.queryLanguage,
	environment: source.environment,
	description: source.description,
	status: source.status,
	entryCount: source.catalogEntryCount,
	catalogTruncated: source.catalogTruncated,
	lastError: source.lastError,
})

export function registerListDataSourcesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Data Sources",
		description:
			"External data sources this org connected for Maple to query in place: databases (ClickHouse SQL) and APIs " +
			"(Clerk, resource queries). One line per data source: name, kind, query language, environment, description, " +
			"how many tables or resources it exposes, and status. Use it for business data that lives outside Maple " +
			"(orders, payments, user accounts). Not for Maple's own traces, logs and metrics (run_sql, query_data, " +
			"search_traces, search_logs) nor for telemetry senders (list_ingest_sources). Knowing the topic but not the " +
			"source? search_data_sources finds the table first. Then describe_data_source, then query_data_source.",
		parameters: Schema.Struct({
			offset: P.offset({ max: 10_000 }),
		}),
		output: ListDataSourcesOutput,
		hints: { readOnly: true },
		phrases: ["Listing data sources", "Checking connected data sources"],
		handler: Effect.fn("McpTool.listDataSources")(function* ({ offset }) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* ExternalDataSourceService
			const sources = yield* service.list(tenant.orgId, AGENT_AUDIENCE).pipe(mapDataSourceError(TOOL))
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
		}),
		render: (output) => {
			if (output.total === 0) {
				return {
					title: "Data sources",
					empty: {
						message:
							"No data sources are connected to this organization (or none allow agent access).",
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
						[
							"Data source",
							"Kind",
							"Query language",
							"Environment",
							"Entries",
							"Status",
							"Description",
						],
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
					doc.next(
						"search_data_sources",
						{ query: "orders" },
						"find which data source and table hold a topic",
					),
					...(first === undefined
						? []
						: [
								doc.next(
									"describe_data_source",
									{ data_source: first.name },
									"a data source's tables or resources",
								),
							]),
				],
			}
		},
	})
}
