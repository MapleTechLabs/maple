// AI agent sessions — the warehouse queries that resolve sessions and their
// spans from the `maple_ai.*` attributes the ingest gateway stamps at decode
// time, plus the integration layer that maps each raw span onto Maple's
// standardised AI agent span format.
//
// The span shape itself — the `AI_GENAI_FIELDS` catalog and the schema
// generated from it — lives in `@maple/domain/gen-ai`, so the wire contract and
// the decoder read one list.

export {
	aiSessionDetailsQuery,
	aiSessionDetailsSlices,
	aiSessionDistributionsQuery,
	aiSessionFacetsQuery,
	aiSessionPageQuery,
	mergeAiSessionDetails,
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
	type AiSessionDistributionMeasure,
	type AiSessionDistributionsOutput,
	type AiSessionFacetType,
	type AiSessionFacetsOutput,
	type AiSessionFilterOpts,
	type AiSessionDetailsOpts,
	type AiSessionDetailsOutput,
	type AiSessionDetailsSlice,
	type AiSessionPageOpts,
	type AiSessionPageOutput,
	type AiSessionSpansOpts,
	type AiSessionSpansOutput,
	type AiSessionSummaryOutput,
	type AiSessionTotalsOutput,
	type AiSessionWindowOutput,
} from "./ai-sessions"

export {
	aiToolDescriptionQuery,
	aiToolDescriptionRowSchema,
	aiToolErrorOccurrencesQuery,
	aiToolErrorOccurrencesRowSchema,
	aiToolErrorSessionsQuery,
	aiToolErrorSessionsRowSchema,
	aiToolErrorsQuery,
	aiToolErrorsRowSchema,
	aiToolsBreakdownsQuery,
	aiToolsSeriesKind,
	aiToolsSeriesQuery,
	aiToolsTotalsQuery,
	AI_TOOL_ERRORS_LIMIT,
	AI_TOOL_ERROR_PAYLOAD_MAX,
	AI_TOOL_OCCURRENCES_LIMIT,
	AI_TOOLS_BREAKDOWN_LIMIT,
	AI_TOOLS_SERIES_MAX_KEYS,
	type AiToolDescriptionOutput,
	type AiToolErrorOccurrencesOutput,
	type AiToolErrorSessionsOutput,
	type AiToolErrorsOpts,
	type AiToolErrorsOutput,
	type AiToolsBreakdownsOutput,
	type AiToolsFilterOpts,
	type AiToolsPeriod,
	type AiToolsSeriesKind,
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
