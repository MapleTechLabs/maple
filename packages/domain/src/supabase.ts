// Stored shapes shared by the HTTP contract (`./http/integrations.ts`) and the Postgres tables.

import { Schema } from "effect"

/**
 * A log drain configured on a Supabase project, as discovery last listed it. Only the destination
 * host is kept: drain configs carry API keys and auth headers.
 */
export const SupabaseLogDrainSummary = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** Supabase's `backend_type`: `otlp`, `datadog`, `s3`, `webhook`, ... */
	backendType: Schema.String,
	/** Host, bucket or region the drain sends to; null when the config names none. */
	destination: Schema.NullOr(Schema.String),
	/** The drain sends to this Maple deployment's ingest gateway. */
	toMaple: Schema.Boolean,
	/** Maple's integration created it (the project's managed drain). */
	managedByMaple: Schema.Boolean,
})
export type SupabaseLogDrainSummary = typeof SupabaseLogDrainSummary.Type

export const SupabaseAdvisorLevel = Schema.Literals(["ERROR", "WARN", "INFO"])
export type SupabaseAdvisorLevel = typeof SupabaseAdvisorLevel.Type

/** Which Management API advisor reported a lint. */
export const SupabaseAdvisorKind = Schema.Literals(["performance", "security"])
export type SupabaseAdvisorKind = typeof SupabaseAdvisorKind.Type

/** One advisor finding (a Splinter lint such as `unindexed_foreign_keys`), as stored and served. */
export const SupabaseAdvisorLint = Schema.Struct({
	advisor: SupabaseAdvisorKind,
	/** The lint id, e.g. `rls_disabled_in_public`. */
	name: Schema.String,
	title: Schema.String,
	level: SupabaseAdvisorLevel,
	/** `PERFORMANCE`, `SECURITY`, `HEALTH`. */
	categories: Schema.Array(Schema.String),
	description: Schema.String,
	/** The finding itself, naming the object (markdown-ish text from Supabase). */
	detail: Schema.String,
	/** A docs URL. */
	remediation: Schema.String,
	/** The database object the lint is about, when it names one. */
	schema: Schema.NullOr(Schema.String),
	object: Schema.NullOr(Schema.String),
	/** `table`, `view`, `function`, `extension`, `auth`... */
	objectType: Schema.NullOr(Schema.String),
	cacheKey: Schema.String,
})
export type SupabaseAdvisorLint = typeof SupabaseAdvisorLint.Type

/** One `pg_stat_statements` entry, ranked by total execution time. */
export const SupabaseTopQuery = Schema.Struct({
	/** `queryid` as text (a 64-bit hash). */
	queryId: Schema.String,
	/** Normalized statement text (`$1` placeholders), cut at 2000 chars. */
	query: Schema.String,
	calls: Schema.Number,
	totalExecMs: Schema.Number,
	meanExecMs: Schema.Number,
	rows: Schema.Number,
})
export type SupabaseTopQuery = typeof SupabaseTopQuery.Type
