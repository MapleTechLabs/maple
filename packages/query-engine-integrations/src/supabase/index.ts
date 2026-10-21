// Supabase integration queries: the /infra/supabase project table and per-project charts.

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
