import type { CompiledQuery, CompiledQueryInput } from "@maple/query-engine/ch"
import { executeLocalQuery, LOCAL_ORG_ID, type LocalQueryError } from "@maple/query-engine/local"
import { Duration, Effect, type Option, Schedule, Schema } from "effect"
import type { HttpClient } from "effect/http"
import type { TimeBounds } from "../lib/time"

// Local queries as Effects: compile, POST `/local/query`, decode the rows.

/** A failed load as the Model keeps it: the text `ErrorState` shows (`error.message`). */
export const LoadFailure = Schema.Struct({ message: Schema.String })
export type LoadFailure = typeof LoadFailure.Type

const failureOf = (error: { readonly message: string }): LoadFailure => ({ message: error.message })

const resolve = <T>(compiled: CompiledQueryInput<T>): Effect.Effect<CompiledQuery<T>, LoadFailure> =>
	(Effect.isEffect(compiled) ? compiled : Effect.succeed(compiled)).pipe(Effect.mapError(failureOf))

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
		Effect.mapError(failureOf),
	)

/** `executeLocalCompiledQuery`: every row, decoded with the query's own row schema. */
export const queryRows = <T>(
	compiled: CompiledQueryInput<T>,
	apiBase: string,
): Effect.Effect<ReadonlyArray<T>, LoadFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const query = yield* resolve(compiled)
		const rows = yield* run(query.sql, apiBase)
		return yield* query.decodeRows(rows).pipe(Effect.mapError(failureOf))
	})

/** `executeLocalCompiledFirstRow`. */
export const queryFirstRow = <T>(
	compiled: CompiledQueryInput<T>,
	apiBase: string,
): Effect.Effect<Option.Option<T>, LoadFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const query = yield* resolve(compiled)
		const rows = yield* run(query.sql, apiBase)
		return yield* query.decodeFirstRow(rows).pipe(Effect.mapError(failureOf))
	})

/** `localParams`: the org and window nearly every local query compiles with. */
export const localParams = (bounds: TimeBounds) => ({
	orgId: LOCAL_ORG_ID,
	startTime: bounds.startTime,
	endTime: bounds.endTime,
})
