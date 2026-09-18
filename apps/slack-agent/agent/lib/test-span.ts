/**
 * Test-only: run a function under an active, sampled OTel span — the way the Node SDK's spans are
 * active in production. Not imported by any production module; lives beside `fetch-stub.ts` for
 * the same reason it does (a shared seam that no `*.test.ts` should have to import from another).
 */
import { context, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"

// Without a context manager `startActiveSpan` never makes the span visible to `getActiveSpan()`.
// A second registration in one process is refused; `withActiveSpan` checks the outcome instead.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

const tracer = new BasicTracerProvider().getTracer("test")

export const withActiveSpan = <A>(
	name: string,
	fn: (ids: { traceId: string; spanId: string }) => Promise<A>,
): Promise<A> =>
	tracer.startActiveSpan(name, async (span) => {
		try {
			if (trace.getActiveSpan() !== span) throw new Error("no active-span context manager")
			return await fn(span.spanContext())
		} finally {
			span.end()
		}
	})
