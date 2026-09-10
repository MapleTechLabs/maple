// AI agent sessions — the warehouse queries that resolve sessions and their
// spans from the `maple_ai.*` attributes the ingest gateway stamps at decode
// time, plus the integration layer that maps each raw span onto Maple's
// standardised AI agent span format.
//
// The span shape itself — the `AI_GENAI_FIELDS` catalog and the schema
// generated from it — lives in `@maple/domain/gen-ai`, so the wire contract and
// the decoder read one list.

export {
	aiSessionFacetsQuery,
	aiSessionDetailsQuery,
	aiSessionPageQuery,
	aiSessionSpansQuery,
	aiSessionSpansRowSchema,
	aiSessionSummaryQuery,
	aiSessionSummaryRowSchema,
	aiSessionTotalsQuery,
	aiSessionTotalsRowSchema,
	aiSessionWindowQuery,
	aiTraceSpansQuery,
	aiTraceSummaryQuery,
	aiTraceTotalsQuery,
	aiTraceWindowQuery,
	idSearchPattern,
	type AiSessionFacetType,
	type AiSessionFacetsOutput,
	type AiSessionFilterOpts,
	type AiSessionDetailsOpts,
	type AiSessionDetailsOutput,
	type AiSessionPageOpts,
	type AiSessionPageOutput,
	type AiSessionSpansOpts,
	type AiSessionSpansOutput,
	type AiSessionSummaryOutput,
	type AiSessionTotalsOutput,
	type AiSessionWindowOutput,
} from "./ai-sessions"

export {
	aiToolsBreakdownsQuery,
	aiToolsSeriesKind,
	aiToolsSeriesQuery,
	aiToolsSessionsQuery,
	aiToolsTotalsQuery,
	AI_TOOLS_BREAKDOWN_LIMIT,
	AI_TOOLS_SERIES_MAX_KEYS,
	AI_TOOLS_SESSIONS_LIMIT,
	type AiToolsBreakdownKind,
	type AiToolsBreakdownsOutput,
	type AiToolsFilterOpts,
	type AiToolsPeriod,
	type AiToolsSeriesKind,
	type AiToolsSessionsOpts,
	type AiToolsTotalsOutput,
	type AiToolsWindow,
} from "./ai-tools"

export {
	aiFieldSourceKeys,
	aiSpanAttributeKeys,
	genAiIntegration,
	mapAiSpan,
	mapAiSpans,
	resolveAiIntegration,
	type AiIntegration,
	type AiRefineContext,
} from "./ai-integrations"
