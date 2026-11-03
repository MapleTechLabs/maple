import { Context, Effect, Scope, Tracer } from "effect"
import { HttpServerRequest } from "effect/http"
import { DrainRunOnInterrupt, PgConnectionScope } from "./pg-connection-scope"

/**
 * `context` without what belongs to the invocation (request, cron tick, Workflow run) it was
 * read in: the Postgres scope, the drain flag, the Scope, the parent span and the request.
 *
 * A context kept and provided again on later invocations would override their live values with
 * these, so a later tool call ran on the first request's closed Postgres scope.
 */
export const withoutInvocationContext = <R>(context: Context.Context<R>) =>
	Context.omit(
		PgConnectionScope,
		DrainRunOnInterrupt,
		Scope.Scope,
		Tracer.ParentSpan,
		HttpServerRequest.HttpServerRequest,
	)(context)

/** `Effect.context`, safe to keep and provide on later invocations. */
export const captureReusableContext = <R>() => Effect.map(Effect.context<R>(), withoutInvocationContext)
