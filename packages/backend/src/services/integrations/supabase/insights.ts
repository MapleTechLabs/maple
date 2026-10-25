/**
 * Supabase project insights over the Management API: the performance and security advisors
 * (`GET /v1/projects/{ref}/advisors/{kind}`) and the slowest statements from `pg_stat_statements`
 * (`POST /v1/projects/{ref}/database/query/read-only`, run as `supabase_read_only_user`).
 * Both need the `database:read` OAuth scope. The SQL is a constant; no input reaches it.
 */
import {
	type SupabaseAdvisorKind,
	SupabaseAdvisorLevel,
	type SupabaseAdvisorLint,
	type SupabaseTopQuery,
} from "@maple/domain/http"
import type { SupabaseProjectRef } from "@maple/domain/primitives"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { send, SupabaseApiError } from "./api"

export const TOP_QUERIES_LIMIT = 10
const QUERY_TEXT_CHARS = 2000

/** Supabase's own service roles; their statements (dashboard, Auth, Storage internals) drown out the app's. */
const INTERNAL_ROLES = [
	"supabase_admin",
	"supabase_auth_admin",
	"supabase_storage_admin",
	"supabase_realtime_admin",
	"supabase_replication_admin",
	"supabase_etl_admin",
	"supabase_read_only_user",
	"pgbouncer",
]

/** pg_stat_statements columns as of Postgres 13 (`total_exec_time`, `mean_exec_time`), unchanged through 17. */
export const TOP_QUERIES_SQL =
	`select s.queryid::text as query_id, left(s.query, ${QUERY_TEXT_CHARS}) as query, s.calls, s.total_exec_time, s.mean_exec_time, s.rows ` +
	`from extensions.pg_stat_statements s join pg_roles r on r.oid = s.userid ` +
	`where r.rolname not in (${INTERNAL_ROLES.map((role) => `'${role}'`).join(", ")}) and s.query not ilike '%pg_stat_statements%' ` +
	`order by s.total_exec_time desc limit ${TOP_QUERIES_LIMIT}`

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))

/** `V1ProjectAdvisorsResponse` lint; only `name`, `title` and `level` must be present. */
const LintWire = Schema.Struct({
	name: Schema.String,
	title: Schema.String,
	level: SupabaseAdvisorLevel,
	categories: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
	description: OptionalText,
	detail: OptionalText,
	remediation: OptionalText,
	metadata: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				schema: OptionalText,
				name: OptionalText,
				type: OptionalText,
			}),
		),
	),
	cache_key: OptionalText,
})
const decodeLint = Schema.decodeUnknownOption(LintWire)
const decodeAdvisorsBody = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ lints: Schema.Array(Schema.Unknown) })),
)

/** Numbers may come back as JSON numbers or, for bigint columns, as strings. */
const Numeric = Schema.Union([Schema.Finite, Schema.FiniteFromString])
const StatementWire = Schema.Struct({
	query_id: Schema.NullOr(Schema.String),
	query: Schema.NullOr(Schema.String),
	calls: Numeric,
	total_exec_time: Numeric,
	mean_exec_time: Numeric,
	rows: Numeric,
})
const decodeStatement = Schema.decodeUnknownOption(StatementWire)
const decodeRowsBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))

/** A lint that does not decode is dropped; an advisor keeps the rest. */
export const decodeLints = (kind: SupabaseAdvisorKind, raw: ReadonlyArray<unknown>) =>
	raw.flatMap((item): Array<SupabaseAdvisorLint> =>
		Option.match(decodeLint(item), {
			onNone: () => [],
			onSome: (lint) => [
				{
					advisor: kind,
					name: lint.name,
					title: lint.title,
					level: lint.level,
					categories: lint.categories ?? [],
					description: lint.description ?? "",
					detail: lint.detail ?? "",
					remediation: lint.remediation ?? "",
					schema: lint.metadata?.schema ?? null,
					object: lint.metadata?.name ?? null,
					objectType: lint.metadata?.type ?? null,
					cacheKey: lint.cache_key ?? `${kind}:${lint.name}`,
				},
			],
		}),
	)

export const decodeStatements = (raw: ReadonlyArray<unknown>) =>
	raw.flatMap((item): Array<SupabaseTopQuery> =>
		Option.match(decodeStatement(item), {
			onNone: () => [],
			onSome: (row) => [
				{
					queryId: row.query_id ?? "",
					query: row.query ?? "",
					calls: row.calls,
					totalExecMs: row.total_exec_time,
					meanExecMs: row.mean_exec_time,
					rows: row.rows,
				},
			],
		}),
	)

const unexpectedBody = (what: string) =>
	new SupabaseApiError({ message: `Supabase returned an unexpected body while ${what}`, kind: "upstream" })

/** One advisor's lints. */
export const getAdvisors = Effect.fn("SupabaseApi.getAdvisors")(function* (
	httpClient: HttpClient.HttpClient,
	apiBaseUrl: string,
	accessToken: string,
	projectRef: SupabaseProjectRef,
	kind: SupabaseAdvisorKind,
) {
	yield* Effect.annotateCurrentSpan({
		"maple.supabase.project_ref": projectRef,
		"maple.supabase.advisor": kind,
	})
	const what = `reading the ${kind} advisors`
	const text = yield* send(
		httpClient,
		HttpClientRequest.get(`${apiBaseUrl}/v1/projects/${projectRef}/advisors/${kind}`).pipe(
			HttpClientRequest.bearerToken(accessToken),
			HttpClientRequest.acceptJson,
		),
		what,
	)
	const body = decodeAdvisorsBody(text)
	if (Option.isNone(body)) return yield* unexpectedBody(what)
	const lints = decodeLints(kind, body.value.lints)
	yield* Effect.annotateCurrentSpan({
		"maple.supabase.lints": lints.length,
		"maple.supabase.lints_skipped": body.value.lints.length - lints.length,
	})
	return lints
})

/** The top statements by total execution time. A refused query (e.g. no privilege) fails with its message. */
export const getTopQueries = Effect.fn("SupabaseApi.getTopQueries")(function* (
	httpClient: HttpClient.HttpClient,
	apiBaseUrl: string,
	accessToken: string,
	projectRef: SupabaseProjectRef,
) {
	yield* Effect.annotateCurrentSpan({ "maple.supabase.project_ref": projectRef })
	const what = "reading pg_stat_statements"
	const text = yield* send(
		httpClient,
		HttpClientRequest.post(`${apiBaseUrl}/v1/projects/${projectRef}/database/query/read-only`).pipe(
			HttpClientRequest.bearerToken(accessToken),
			HttpClientRequest.acceptJson,
			HttpClientRequest.bodyJsonUnsafe({ query: TOP_QUERIES_SQL }),
		),
		what,
	)
	const rows = decodeRowsBody(text)
	if (Option.isNone(rows)) return yield* unexpectedBody(what)
	return decodeStatements(rows.value)
})
