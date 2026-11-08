import { Array as Arr, Effect, String as Str } from "effect"
import type { ExternalDataSourceServiceError } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import type { ExternalDataSourceDocument, QueryLanguage, QueryPlanSummary } from "@maple/domain/data-sources"
import { McpInvalidInputError, McpQueryBudgetError, McpQueryError, McpUnavailableError } from "../tools/types"
import { truncate } from "./format"

/** The data source tools read through the agent audience: hidden sources and PII stay out. */
export const AGENT_AUDIENCE = { agent: true } as const

/** Above this many sources the prompt names a count, not every source. */
export const MAX_PROMPT_SOURCES = 30

/** Roughly 40 tokens per source line. */
const MAX_LINE_DESCRIPTION_CHARS = 160

const SQL_DIALECT_NAMES: ReadonlyMap<string, string> = new Map([
	["clickhouse", "ClickHouse"],
	["postgres", "PostgreSQL"],
	["mysql", "MySQL"],
])

/** `ClickHouse SQL`, `resource query`. */
export const queryLanguageLabel = (language: QueryLanguage): string => {
	if (language === "resource") return "resource query"
	const dialect = Str.replace("sql:", "")(language)
	return `${SQL_DIALECT_NAMES.get(dialect) ?? dialect} SQL`
}

/** `name (kind, query language, environment): description`, one per source. */
export const dataSourceLine = (source: {
	readonly name: string
	readonly kind: string
	readonly queryLanguage: QueryLanguage
	readonly environment: string
	readonly description: string
}): string =>
	`${source.name} (${source.kind}, ${queryLanguageLabel(source.queryLanguage)}, ${source.environment}): ${truncate(
		Str.replace(/\s+/g, " ")(source.description),
		MAX_LINE_DESCRIPTION_CHARS,
	)}`

/** The plan's one-line summary: expanded SQL, or the API calls and rows it reads. */
export const planLine = (plan: QueryPlanSummary): string =>
	plan._tag === "sql"
		? `SQL as sent: ${truncate(Str.replace(/\s+/g, " ")(plan.sql), 400)}`
		: `${plan.calls} API call${plan.calls === 1 ? "" : "s"}, up to ${plan.maxRows} rows (${plan.strategy}): ${plan.description}`

/** What the org's sources add to an agent's system prompt; undefined when it has none. */
export const dataSourcesPromptSection = (
	sources: ReadonlyArray<ExternalDataSourceDocument>,
): string | undefined => {
	if (sources.length === 0) return undefined
	const heading =
		"## Connected data sources\nThis org connected external databases and APIs (separate from Maple's own telemetry). Find data in them with `search_data_sources`, read an entry's fields with `describe_data_source`, and query with `query_data_source`."
	if (sources.length > MAX_PROMPT_SOURCES) {
		return `${heading}\nThere are ${sources.length} data sources; use \`search_data_sources\` to find the right one.`
	}
	return `${heading}\n${Arr.join(
		Arr.map(sources, (source) => `- ${dataSourceLine(source)}`),
		"\n",
	)}`
}

const withSuggestions = (message: string, suggestions: ReadonlyArray<string>): string =>
	suggestions.length === 0 || Str.includes("Did you mean")(message)
		? message
		: `${message} Did you mean ${Arr.join(
				Arr.map(suggestions, (name) => `"${name}"`),
				" or ",
			)}?`

/** Service failures as the registry's typed MCP errors. */
export const toMcpDataSourceError =
	(tool: string, parameter = "data_source") =>
	(
		error: ExternalDataSourceServiceError,
	): McpInvalidInputError | McpQueryBudgetError | McpQueryError | McpUnavailableError => {
		switch (error._tag) {
			case "@maple/data-sources/NotFound":
				return new McpInvalidInputError({
					message: withSuggestions(error.message, error.suggestions),
					parameter,
				})
			case "@maple/data-sources/Validation":
				return new McpInvalidInputError({
					message: error.message,
					...(error.field === undefined ? undefined : { parameter: error.field }),
				})
			case "@maple/data-sources/Limit":
				return new McpQueryBudgetError({
					message: error.message,
					pipeName: tool,
					setting: "data_source_limit",
				})
			case "@maple/data-sources/RateLimited":
				return new McpQueryBudgetError({
					message:
						error.retryAfterSeconds === undefined
							? error.message
							: `${error.message} Retry in about ${error.retryAfterSeconds} seconds.`,
					pipeName: tool,
					setting: "data_source_rate_limit",
				})
			case "@maple/data-sources/Connection":
				return new McpUnavailableError({
					message: `Maple could not reach the data source (${error.reason}): ${error.message}`,
					capability: "data_source_connection",
				})
			// The source answered too slowly for this window: a smaller question is the fix, not a retry.
			case "@maple/data-sources/Timeout":
				return new McpQueryBudgetError({
					message: `${error.message}. Narrow the time window, aggregate instead of listing rows, or add a LIMIT.`,
					pipeName: tool,
					setting: "data_source_timeout",
				})
			case "@maple/data-sources/Query":
				return new McpQueryError({
					message: `The data source rejected the query: ${error.message}`,
					pipeName: tool,
				})
			case "@maple/data-sources/Persistence":
				return new McpQueryError({ message: error.message, pipeName: tool, cause: error })
		}
	}

/** `Effect.mapError` over a service call. */
export const mapDataSourceError =
	(tool: string, parameter?: string) =>
	<A, R>(effect: Effect.Effect<A, ExternalDataSourceServiceError, R>) =>
		Effect.mapError(effect, toMcpDataSourceError(tool, parameter))
