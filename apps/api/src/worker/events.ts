/**
 * What a background event (a cron fire, a queue batch) shares.
 */
import { Cause, Effect, type Layer } from "effect"
import { withPgConnectionScope } from "../platform/pg-connection-scope"

/**
 * One background event: its program on one Postgres socket, over the layer it
 * owns — built into the event and released with it, which is what flushes the
 * event's telemetry when it ends. The ports sit in `layer`, so the connection
 * scope finds `MapleDbConnection` there.
 */
export const runEvent = <A, E, R, ROut, E2>(
	program: Effect.Effect<A, E, R>,
	layer: Layer.Layer<ROut, E2, never>,
) =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the event IS the boundary the layer belongs to.
	withPgConnectionScope(program).pipe(Effect.provide(layer))

/**
 * A fire's outcome: interrupts are isolate teardown (the schedule re-fires) and
 * a failure is logged rather than re-raised — alchemy's cron source swallows
 * every cause without logging, so this is the only signal of a failed run.
 */
export const settleFire =
	(cron: string) =>
	<A, E, R>(fire: Effect.Effect<A, E, R>) =>
		fire.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Effect.logError("API cron fire failed", cause).pipe(
							Effect.annotateLogs({ "maple.api.cron": cron }),
						),
			),
		)
