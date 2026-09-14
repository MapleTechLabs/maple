/**
 * The single Postgres boundary services put in front of `Database.execute`.
 *
 * Every service that touches the application database needs the same three
 * things — replay a contention failure, log it with enough context to name the
 * operation, then map it into that service's public persistence error. Keeping
 * one implementation here is what stops the fifteen copies this replaced from
 * drifting into fifteen different contracts again.
 */
import type { MapleDb } from "@maple/db/client"
import { Effect, Schedule } from "effect"
import { describeCause } from "./describe-cause"
import { DatabaseError, type DatabaseApi } from "./DatabaseLive"
import { isRetryablePostgresContention } from "./postgres-errors"

/** Contention (SQLSTATE 40001/40P01) is safe to replay as a fresh attempt. */
const CONTENTION_RETRY_SCHEDULE = Schedule.max([Schedule.exponential("50 millis", 2.0), Schedule.recurs(3)])

/**
 * Every domain persistence error is a `Schema.TaggedError` over the same two
 * fields, which is what lets one mapper serve all of them.
 */
type PersistenceErrorConstructor<E> = new (fields: { readonly message: string; readonly cause?: string }) => E

/**
 * Build the `unknown -> E` mapper each service used to hand-roll: the thrown
 * message when there is one, the flattened nested cause when there is one, and
 * `fallbackMessage` for a non-`Error` rejection that carries neither.
 */
export const makePersistenceErrorMapper =
	<E>(Ctor: PersistenceErrorConstructor<E>, fallbackMessage: string) =>
	(error: unknown): E => {
		const isError = error instanceof Error
		const cause = describeCause(isError ? error.cause : error)
		return new Ctor({
			message: isError ? error.message : fallbackMessage,
			...(!(cause === undefined) ? { cause } : undefined),
		})
	}

/**
 * Wrap a service's database access: contention retry, one structured error log
 * naming the service and the failing operation, then the service's own error.
 *
 * Only the `DatabaseError` half is retried, logged and remapped. Whatever the
 * callback failed with on its own — a domain error raised inside a transaction
 * to roll it back — passes through untouched, which is the point of the typed
 * channel replacing `throw`.
 *
 * `service` only labels the logs — the operation name comes from the ambient
 * span, so a service method already wrapped in `Effect.fn` needs no extra
 * plumbing to say which query failed.
 */
export const makeDbExecute =
	<E>(database: DatabaseApi, service: string, mapError: (error: DatabaseError) => E) =>
	<A, E2, R>(fn: (db: MapleDb) => Effect.Effect<A, E2, R>) =>
		database.execute(fn).pipe(
			Effect.retry({
				schedule: CONTENTION_RETRY_SCHEDULE,
				while: (error) => error instanceof DatabaseError && isRetryablePostgresContention(error),
			}),
			Effect.tapError((error) =>
				error instanceof DatabaseError
					? Effect.gen(function* () {
							// Service methods run inside an Effect.fn span — its name says which
							// operation's query failed without threading a label through.
							const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => null))
							yield* Effect.logError(`${service} dbExecute failed`).pipe(
								Effect.annotateLogs({
									service,
									operation: span?.name ?? "(unknown)",
									message: error.message,
									cause: describeCause(error.cause) ?? "(none)",
								}),
							)
						})
					: Effect.void,
			),
			Effect.catchIf(
				(error): error is DatabaseError => error instanceof DatabaseError,
				(error) => Effect.fail(mapError(error)),
			),
		)
