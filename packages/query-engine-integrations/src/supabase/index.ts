// Supabase integration queries: the /infra/supabase project table, per-project charts and insights.

export {
	SUPABASE_DATA_MOUNTPOINT,
	SUPABASE_PROJECT_REF_ATTRIBUTE,
	supabaseProjectCpuSQL,
	supabaseProjectGaugesSQL,
	supabaseProjectGaugeSeriesSQL,
	supabaseProjectRateSeriesSQL,
	type SupabaseProjectCpuOutput,
	type SupabaseProjectGaugesOutput,
	type SupabaseProjectGaugeSeriesOutput,
	type SupabaseProjectRateSeriesOutput,
} from "./supabase-infra"

export {
	SUPABASE_LOG_PROJECT_REF_ATTRIBUTE,
	SUPABASE_LOG_SOURCE_ATTRIBUTE,
	SUPABASE_LOGS_SERVICE_NAME,
	supabaseApiTopPathsSQL,
	supabaseApiTrafficSeriesSQL,
	supabaseApiTrafficTotalsSQL,
	supabaseLogIssuesSQL,
	supabaseLogsProjectsSummarySQL,
	supabaseProjectCallerSeriesSQL,
	supabaseProjectCallersSQL,
	type SupabaseApiTopPathsOutput,
	type SupabaseApiTrafficSeriesOutput,
	type SupabaseApiTrafficTotalsOutput,
	type SupabaseLogIssuesOpts,
	type SupabaseLogIssuesOutput,
	type SupabaseLogsProjectSummaryOutput,
	type SupabaseProjectCallerSeriesOutput,
	type SupabaseProjectCallersOutput,
} from "./supabase-insights"
