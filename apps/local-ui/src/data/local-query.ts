import type { CompiledQuery, CompiledQueryInput } from "@maple/query-engine/ch"
import { executeLocalQuery, LOCAL_ORG_ID, type LocalQueryError } from "@maple/query-engine/local"
import { Duration, Effect, type Option, Schedule } from "effect"
import type { HttpClient } from "effect/http"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { type RequestKey, requestKey } from "@maple/views/data/request-key"
import type { TimeBounds } from "../lib/time"

// Local queries as Effects: compile, POST `/local/query`, decode the rows.

/** A request key for one local query: the local org, its name and its input. */
export const keyOf = (name: string, input: unknown): RequestKey => requestKey(LOCAL_ORG_ID, name, input)

/**
 * A failed local load: the query's own message, and Try again without the auto-retry (the query
 * already retried a dropped request). Views name the subject in `errorState`'s title.
 */
export const localFailure = (error: { readonly message: string }): LoadFailure => ({
	_tag: "@maple/local/errors/LoadFailed",
	type: "api_error",
	code: "local_query_failed",
	title: "Couldn’t load data",
	message: error.message,
	retryable: false,
	recovery: "retry",
})

const resolve = <T>(compiled: CompiledQueryInput<T>): Effect.Effect<CompiledQuery<T>, LoadFailure> =>
	(Effect.isEffect(compiled) ? compiled : Effect.succeed(compiled)).pipe(Effect.mapError(localFailure))

/**
 * `shouldRetryLocalQuery` with fixed delays: only a request that never got an
 * answer is retried, twice, after 1 s and 2 s.
 */
const run = (sql: string, apiBase: string) =>
	executeLocalQuery(sql, apiBase).pipe(
		Effect.retry({
			schedule: Schedule.exponential(Duration.seconds(1)),
			times: 2,
			while: (error: LocalQueryError) => error._tag === "@maple/query-engine/LocalQueryUnreachable",
		}),
		Effect.mapError(localFailure),
	)

/** `executeLocalCompiledQuery`: every row, decoded with the query's own row schema. */
export const queryRows = <T>(
	compiled: CompiledQueryInput<T>,
	apiBase: string,
): Effect.Effect<ReadonlyArray<T>, LoadFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const query = yield* resolve(compiled)
		const rows = yield* run(query.sql, apiBase)
		return yield* query.decodeRows(rows).pipe(Effect.mapError(localFailure))
	})

/** `executeLocalCompiledFirstRow`. */
export const queryFirstRow = <T>(
	compiled: CompiledQueryInput<T>,
	apiBase: string,
): Effect.Effect<Option.Option<T>, LoadFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const query = yield* resolve(compiled)
		const rows = yield* run(query.sql, apiBase)
		return yield* query.decodeFirstRow(rows).pipe(Effect.mapError(localFailure))
	})

/** `localParams`: the org and window nearly every local query compiles with. */
export const localParams = (bounds: TimeBounds) => ({
	orgId: LOCAL_ORG_ID,
	startTime: bounds.startTime,
	endTime: bounds.endTime,
})
