/**
 * What a background event (a cron fire, a queue batch) shares: the layer it
 * owns, built into the event and released with it, and how a fire settles.
 */
import { Cause, Effect, type Layer } from "effect"

/**
 * An event's program over the layers it owns — its light service graph and,
 * for background work, its own SDK instance underneath it — built into the
 * event and released with it. The one place a handler provides a Layer: the
 * build and the SDK's flush finalizer are scoped to the event on purpose,
 * which is what flushes the event's telemetry when it ends.
 */
export const provideEvent =
	<ROut, E2, RIn>(layers: Layer.Layer<ROut, E2, RIn>) =>
	<A, E, R>(program: Effect.Effect<A, E, R>) =>
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(program, layers)

/**
 * A fire's outcome: interrupts are isolate teardown (the schedule re-fires) and
 * a failure is logged rather than re-raised — alchemy's cron source reports
 * every fire as successful anyway.
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
