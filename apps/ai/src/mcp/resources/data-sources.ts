import { McpServer } from "effect/ai"
import { Array as Arr, Effect, Layer } from "effect"
import type { ExternalDataSourceDocument } from "@maple/domain/data-sources"
import type { TenantContext } from "@maple/domain/http"
import { McpToolExecutorLoader } from "../executor-loader"
import { CurrentMcpRequestTenant } from "../tenant"
import { dataSourceLine, mayReadDataSources } from "../lib/data-sources"

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
			"Query with `query_data_source`. `list_data_sources` finds a table by topic (`query`) and gives a source's tables and an entry's fields (`data_source`, `entries`).",
			...Arr.map(shown, (source) => `- ${dataSourceLine(source)}`),
			...(sources.length > shown.length
				? [`(${sources.length - shown.length} more; use \`list_data_sources\` with an offset.)`]
				: []),
		],
		"\n",
	)
}

/** What a scoped key without the scope reads: the same answer `list_data_sources` gives it. */
export const DATA_SOURCES_SCOPE_MISSING =
	"This API key lacks the `data_sources:read` scope, so it cannot read the organization's data sources. Add the scope to the key, or use a full-access key."

/** What the resource answers one caller. Without the scope nothing is listed, and nothing is loaded. */
export const readDataSourcesResource = <E, R>(
	tenant: TenantContext | undefined,
	list: (tenant: TenantContext) => Effect.Effect<ReadonlyArray<ExternalDataSourceDocument>, E, R>,
): Effect.Effect<string, E, R> => {
	if (tenant === undefined) return Effect.succeed("The authenticated organization is unavailable.")
	if (!mayReadDataSources(tenant)) return Effect.succeed(DATA_SOURCES_SCOPE_MISSING)
	return Effect.map(list(tenant), dataSourcesResourceText)
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
				return yield* readDataSourcesResource(tenant, (reader) =>
					Effect.flatMap(loader.load, (executor) => executor.listDataSources(reader)),
				)
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
