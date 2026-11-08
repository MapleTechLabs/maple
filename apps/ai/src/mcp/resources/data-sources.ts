import { McpServer } from "effect/ai"
import { Array as Arr, Effect, Layer } from "effect"
import type { ExternalDataSourceDocument } from "@maple/domain/data-sources"
import { McpToolExecutorLoader } from "../executor-loader"
import { CurrentMcpRequestTenant } from "../lib/query-warehouse"
import { dataSourceLine } from "../lib/data-sources"

/** More than this and the resource points at search instead of listing every source. */
const MAX_RESOURCE_SOURCES = 200

export const dataSourcesResourceText = (sources: ReadonlyArray<ExternalDataSourceDocument>): string => {
	if (sources.length === 0) {
		return "No data sources are connected to this organization (or none allow agent access). An admin connects one in Settings -> Data sources; credentials never go through chat."
	}
	const shown = Arr.take(sources, MAX_RESOURCE_SOURCES)
	return Arr.join(
		[
			`# Connected data sources (${sources.length})`,
			"Query with `query_data_source`; read an entry's fields first with `describe_data_source`. `search_data_sources` finds a table by topic.",
			...Arr.map(shown, (source) => `- ${dataSourceLine(source)}`),
			...(sources.length > shown.length
				? [`(${sources.length - shown.length} more; use \`list_data_sources\` with an offset.)`]
				: []),
		],
		"\n",
	)
}

/** The org's agent-visible data sources, one line each. Org-scoped: read with the request's tenant. */
export const DataSourcesResource = Layer.unwrap(
	Effect.gen(function* () {
		const loader = yield* McpToolExecutorLoader
		return McpServer.resource({
			uri: "maple://data-sources",
			name: "Connected Data Sources",
			description:
				"External databases and APIs this organization connected for querying with query_data_source",
			audience: ["assistant"] as ReadonlyArray<"user" | "assistant">,
			priority: 0.5,
			content: Effect.gen(function* () {
				const tenant = yield* CurrentMcpRequestTenant
				if (tenant === undefined) return "The authenticated organization is unavailable."
				const executor = yield* loader.load
				const sources = yield* executor.listDataSources(tenant)
				return dataSourcesResourceText(sources)
			}).pipe(
				Effect.catch((error) =>
					Effect.logWarning("Could not list data sources for the MCP resource").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(
							"The data sources could not be read right now; call list_data_sources instead.",
						),
					),
				),
				Effect.withSpan("McpResource.dataSources"),
			),
		})
	}),
)
