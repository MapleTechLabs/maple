import { Context, Effect } from "effect"

/**
 * How the current invocation runs best-effort work after its response is sent.
 *
 * The API Worker installs one per request over the event's `waitUntil`, so the
 * work keeps the invocation alive without holding the response. Everywhere else
 * (crons, queue consumers, tests) it is unset and the work runs inline.
 */
export class AfterResponse extends Context.Reference<
	((work: Effect.Effect<void>) => Effect.Effect<void>) | undefined
>("@maple/backend/platform/AfterResponse", { defaultValue: () => undefined }) {}

/**
 * Run `work` once the response is out, or inline where nothing can defer it.
 *
 * Deferred work outlives the request's Postgres scope, so it must not touch the
 * database (its calls would be refused as `SCOPE_CLOSED`). It must also not fail:
 * nothing is left to report a failure to.
 */
export const runAfterResponse = <R>(work: Effect.Effect<void, never, R>): Effect.Effect<void, never, R> =>
	Effect.flatMap(AfterResponse, (defer) =>
		defer === undefined
			? work
			: Effect.flatMap(Effect.context<R>(), (context) => defer(Effect.provideContext(work, context))),
	)
