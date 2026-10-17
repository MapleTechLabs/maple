import { EXECUTE_BATCH_WINDOW_MS } from "@maple/web/api/warehouse/execute-batcher"
import {
	QUERY_ENGINE_BATCH_MAX,
	type QueryEngineBatchOutcome,
	type QueryEngineExecuteRequest,
	QueryEngineExecuteResponse,
} from "@maple/query-engine"
import { Deferred, Duration, Effect, Ref, type Scope } from "effect"
import { rejectedFailure, WarehouseQueryError } from "./warehouse-error"

/**
 * apps/web's `makeExecuteBatcher` (`api/warehouse/execute-batcher.ts`) as an Effect: queries
 * enqueued from separate Command fibers within one timer window go out as one
 * `/execute-batch` request, at most `QUERY_ENGINE_BATCH_MAX` per request, and each caller is
 * settled from its own positional outcome. State lives in a `Ref` owned by the resource's scope.
 */

/** Sends one batch; fails only when the whole request fails. */
export type SendExecuteBatch = (
	requests: ReadonlyArray<QueryEngineExecuteRequest>,
) => Effect.Effect<ReadonlyArray<QueryEngineBatchOutcome>, WarehouseQueryError>

export interface ExecuteBatcher {
	readonly execute: (
		operation: string,
		payload: QueryEngineExecuteRequest,
	) => Effect.Effect<QueryEngineExecuteResponse, WarehouseQueryError>
}

interface Pending {
	readonly operation: string
	readonly payload: QueryEngineExecuteRequest
	readonly settled: Deferred.Deferred<QueryEngineExecuteResponse, WarehouseQueryError>
}

interface State {
	readonly pending: ReadonlyArray<Pending>
	/** The armed window timer; a timer whose token is no longer current flushes nothing. */
	readonly timer: number | null
	readonly nextTimer: number
}

const settle = (entry: Pending, outcome: QueryEngineBatchOutcome | undefined) => {
	if (outcome === undefined) {
		return Deferred.fail(
			entry.settled,
			new WarehouseQueryError({
				operation: entry.operation,
				failure: {
					reason: "Failed",
					message: "Batch response was missing a result for this query.",
					retryable: true,
				},
			}),
		)
	}
	return outcome.outcome === "failure"
		? Deferred.fail(
				entry.settled,
				new WarehouseQueryError({
					operation: entry.operation,
					failure: rejectedFailure(outcome.error),
				}),
			)
		: Deferred.succeed(entry.settled, new QueryEngineExecuteResponse({ result: outcome.result }))
}

export const makeExecuteBatcher = (
	send: SendExecuteBatch,
	windowMs: number = EXECUTE_BATCH_WINDOW_MS,
): Effect.Effect<ExecuteBatcher, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const state = yield* Ref.make<State>({ pending: [], timer: null, nextTimer: 0 })

		const dispatch = (batch: ReadonlyArray<Pending>) =>
			send(batch.map((entry) => entry.payload)).pipe(
				Effect.matchEffect({
					// Whole-request failure: every query in this batch failed for the same reason.
					onFailure: (error) =>
						Effect.forEach(batch, (entry) => Deferred.fail(entry.settled, error), {
							discard: true,
						}),
					onSuccess: (outcomes) =>
						Effect.forEach(batch, (entry, index) => settle(entry, outcomes[index]), {
							discard: true,
						}),
				}),
				Effect.forkIn(scope),
			)

		const schedule: Effect.Effect<void> = Effect.flatMap(
			Ref.modify(state, (current): [number | null, State] =>
				current.timer !== null
					? [null, current]
					: [
							current.nextTimer,
							{ ...current, timer: current.nextTimer, nextTimer: current.nextTimer + 1 },
						],
			),
			(token) =>
				token === null
					? Effect.void
					: Effect.asVoid(
							Effect.forkIn(
								Effect.andThen(Effect.sleep(Duration.millis(windowMs)), flush(token)),
								scope,
							),
						),
		)

		/** `token` null: flush now (a full batch); otherwise only if that timer is still the armed one. */
		function flush(token: number | null): Effect.Effect<void> {
			return Effect.flatMap(
				Ref.modify(state, (current): [ReadonlyArray<Pending>, State] => {
					if (token !== null && current.timer !== token) return [[], current]
					const batch = current.pending.slice(0, QUERY_ENGINE_BATCH_MAX)
					return [
						batch,
						{ ...current, pending: current.pending.slice(QUERY_ENGINE_BATCH_MAX), timer: null },
					]
				}),
				(batch) =>
					batch.length === 0
						? Effect.void
						: Effect.andThen(
								dispatch(batch),
								// Anything over the cap goes out as the next batch rather than being dropped.
								Effect.flatMap(Ref.get(state), (current) =>
									current.pending.length > 0 ? schedule : Effect.void,
								),
							),
			)
		}

		const execute = (operation: string, payload: QueryEngineExecuteRequest) =>
			Effect.gen(function* () {
				const settled = yield* Deferred.make<QueryEngineExecuteResponse, WarehouseQueryError>()
				const size = yield* Ref.modify(state, (current): [number, State] => {
					const pending = [...current.pending, { operation, payload, settled }]
					return [pending.length, { ...current, pending }]
				})
				// A full batch has nothing to gain from waiting out the window.
				yield* size >= QUERY_ENGINE_BATCH_MAX ? flush(null) : schedule
				return yield* Deferred.await(settled)
			})

		return { execute } satisfies ExecuteBatcher
	})
