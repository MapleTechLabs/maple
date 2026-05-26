import type { Effect } from "effect"
import { ManagedRuntime } from "effect"
import type { Layer } from "effect"

/**
 * Minimal shape of CF `ExecutionContext.waitUntil`.
 */
export interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void
}

/**
 * Yield one macrotask so Effect's scheduler can drain tasks queued via
 * `scheduleTask(fn, 0)`. `HttpMiddleware.tracer` ends the root Server span this
 * way; `scheduleTask(fn, 0)` dispatches via `setImmediate` → `setTimeout(fn, 0)`
 * on Workers (a macrotask). Disposing the per-invocation runtime the moment the
 * program promise resolves would race that scheduled `span.end` and leave spans
 * parentless. Awaiting one `setTimeout(0)` drains the dispatcher first.
 */
const drainScheduler = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Run a single Effect program to completion under a fresh per-invocation
 * runtime. Intended for CF Worker `scheduled` handlers. Disposes the runtime
 * after the program settles (draining the scheduler first) and registers the
 * whole thing with `ctx.waitUntil`. Rethrows so the CF runtime reports failure.
 */
export const runScheduledEffect = <A, E, R>(
	layer: Layer.Layer<R, unknown, never>,
	program: Effect.Effect<A, E, R>,
	ctx: ExecutionContextLike,
): Promise<A> => {
	const runtime = ManagedRuntime.make(layer)
	const done = runtime.runPromise(program).finally(async () => {
		await drainScheduler()
		await runtime.dispose().catch((err) => {
			console.error("[alerting] scheduled runtime dispose failed:", err)
		})
	})
	ctx.waitUntil(done.catch(() => undefined))
	return done
}
