import {
	QUERY_ENGINE_BATCH_MAX,
	type QueryEngineBatchFailure,
	type QueryEngineBatchOutcome,
	type QueryEngineExecuteRequest,
	QueryEngineExecuteResponse,
} from "@maple/query-engine"
import { EXECUTE_BATCH_WINDOW_MS } from "@maple/web-data/warehouse/execute-batcher"
import { Cause, Deferred, Duration, Effect, Option, Ref, Schema, type Scope } from "effect"

/**
 * `@maple/web-data`'s promise `makeExecuteBatcher` as an Effect: queries enqueued from separate
 * Command fibers within one timer window go out as one `/execute-batch` request, at most
 * `QUERY_ENGINE_BATCH_MAX` per request, and each caller is settled from its own positional
 * outcome. It fails with what the promise batcher rejects with (the per-item public body, or the
 * whole request's error), so `executeQueryEngine` normalizes both apps' failures alike.
 */

/** A batch response with fewer outcomes than queries. */
export class MissingBatchResultError extends Schema.TaggedError<MissingBatchResultError>()(
	"@maple/web/MissingBatchResultError",
	{ message: Schema.String },
) {}

/** Sends one batch; fails only when the whole request fails. */
export type SendExecuteBatch<E> = (
	requests: ReadonlyArray<QueryEngineExecuteRequest>,
) => Effect.Effect<ReadonlyArray<QueryEngineBatchOutcome>, E>

export type ExecuteFailure<E> = E | QueryEngineBatchFailure | MissingBatchResultError

export interface ExecuteBatcher<E> {
	readonly enqueue: (
		payload: QueryEngineExecuteRequest,
	) => Effect.Effect<QueryEngineExecuteResponse, ExecuteFailure<E>>
}

interface Pending<E> {
	readonly payload: QueryEngineExecuteRequest
	readonly settled: Deferred.Deferred<QueryEngineExecuteResponse, ExecuteFailure<E>>
}

interface State<E> {
	readonly pending: ReadonlyArray<Pending<E>>
	/** The armed window timer; a timer whose token is no longer current flushes nothing. */
	readonly timer: number | null
	readonly nextTimer: number
}

const settle = <E>(entry: Pending<E>, outcome: QueryEngineBatchOutcome | undefined) => {
	if (outcome === undefined) {
		return Deferred.fail(
			entry.settled,
			new MissingBatchResultError({ message: "Batch response was missing a result for this query." }),
		)
	}
	// Per-item failures already use the complete public error body.
	return outcome.outcome === "failure"
		? Deferred.fail(entry.settled, outcome.error)
		: Deferred.succeed(entry.settled, new QueryEngineExecuteResponse({ result: outcome.result }))
}

export const makeExecuteBatcher = <E>(
	send: SendExecuteBatch<E>,
	windowMs: number = EXECUTE_BATCH_WINDOW_MS,
): Effect.Effect<ExecuteBatcher<E>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const state = yield* Ref.make<State<E>>({ pending: [], timer: null, nextTimer: 0 })

		const dispatch = (batch: ReadonlyArray<Pending<E>>) =>
			send(batch.map((entry) => entry.payload)).pipe(
				Effect.matchCauseEffect({
					// Whole-request failure: every query in this batch failed for the same reason. A defect or
					// interrupt fails them as unanswered, so each tile shows its error instead of awaiting forever.
					onFailure: (cause) =>
						Option.match(Cause.findErrorOption(cause), {
							onSome: (error): Effect.Effect<ExecuteFailure<E>> => Effect.succeed(error),
							onNone: (): Effect.Effect<ExecuteFailure<E>> =>
								Effect.as(
									Effect.logError("Execute batch send ended without an answer", cause),
									new MissingBatchResultError({ message: "The batch request ended without an answer." }),
								),
						}).pipe(
							Effect.flatMap((error) =>
								Effect.forEach(batch, (entry) => Deferred.fail(entry.settled, error), { discard: true }),
							),
						),
					onSuccess: (outcomes) =>
						Effect.forEach(batch, (entry, index) => settle(entry, outcomes[index]), {
							discard: true,
						}),
				}),
				Effect.forkIn(scope),
			)

		const schedule: Effect.Effect<void> = Effect.flatMap(
			Ref.modify(state, (current): [number | null, State<E>] =>
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
				Ref.modify(state, (current): [ReadonlyArray<Pending<E>>, State<E>] => {
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

		const enqueue = (payload: QueryEngineExecuteRequest) =>
			Effect.gen(function* () {
				const settled = yield* Deferred.make<QueryEngineExecuteResponse, ExecuteFailure<E>>()
				const size = yield* Ref.modify(state, (current): [number, State<E>] => {
					const pending = [...current.pending, { payload, settled }]
					return [pending.length, { ...current, pending }]
				})
				// A full batch has nothing to gain from waiting out the window.
				yield* size >= QUERY_ENGINE_BATCH_MAX ? flush(null) : schedule
				return yield* Deferred.await(settled)
			})

		return { enqueue } satisfies ExecuteBatcher<E>
	})
