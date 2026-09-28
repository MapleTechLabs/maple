import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
	context,
	INVALID_SPAN_CONTEXT,
	ROOT_CONTEXT,
	SpanStatusCode,
	trace,
	TraceFlags,
	type Span,
} from "@opentelemetry/api"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { captureException } from "./errors"
import { resetReportedErrorsForTests } from "./failures"
import { MapleBrowser } from "./index"
import { serverTiming, traced } from "./server"

const exporter = new InMemorySpanExporter()

/** What a server's own OpenTelemetry setup (`@vercel/otel`, the Node SDK) registers. */
function registerServerOtel(): void {
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
	)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
const spans = () => exporter.getFinishedSpans()
const named = (name: string): ReadableSpan => {
	const span = spans().find((candidate) => candidate.name === name)
	if (!span)
		throw new Error(
			`no span named ${name}: ${spans()
				.map((s) => s.name)
				.join(", ")}`,
		)
	return span
}
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
const idOf = (span: ReadableSpan) => span.spanContext().spanId
const exceptionEvents = () =>
	spans().flatMap((span) => span.events.filter((event) => event.name === "exception"))

/** A request: the server span the framework's instrumentation would have open. */
const request = <T>(fn: (span: Span) => Promise<T>): Promise<T> =>
	trace.getTracer("framework").startActiveSpan("GET /projects/[id]", async (span) => {
		try {
			return await fn(span)
		} finally {
			span.end()
		}
	})

beforeEach(() => {
	exporter.reset()
	resetReportedErrorsForTests()
})

afterEach(() => {
	trace.disable()
	context.disable()
})

describe("traced without server OpenTelemetry", () => {
	it("only runs fn, passing its result and error through unchanged", async () => {
		const value = { ok: true }
		await expect(traced("loader", async () => value)).resolves.toBe(value)
		const error = new Error("loader failed")
		await expect(
			traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)
	})

	it("does not claim the error, so a server set up later still records it", async () => {
		const error = new Error("before setup")
		await expect(
			traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)

		registerServerOtel()
		await expect(
			request(() =>
				traced("loader", async () => {
					throw error
				}),
			),
		).rejects.toBe(error)
		expect(exceptionEvents()).toHaveLength(1)
	})
})

describe("traced with server OpenTelemetry", () => {
	beforeEach(registerServerOtel)

	it("spans fn under the active server span and returns its value unchanged", async () => {
		const value = { ok: true }
		await expect(request(() => traced("load project", async () => value))).resolves.toBe(value)
		const span = named("load project")
		expect(parentOf(span)).toBe(idOf(named("GET /projects/[id]")))
		expect(span.status.code).toBe(SpanStatusCode.UNSET)
		expect(span.instrumentationScope.name).toBe("maple-browser")
	})

	it("keeps itself the parent across await, unlike the browser", async () => {
		await request(() =>
			traced("load project", async () => {
				await tick()
				trace.getTracer("db").startSpan("db.query").end()
				await tick()
				trace.getTracer("db").startSpan("db.query 2").end()
			}),
		)
		expect(parentOf(named("db.query"))).toBe(idOf(named("load project")))
		expect(parentOf(named("db.query 2"))).toBe(idOf(named("load project")))
	})

	it("nests a traced call inside another under that one", async () => {
		await request(() => traced("outer", async () => traced("inner", async () => tick())))
		expect(parentOf(named("inner"))).toBe(idOf(named("outer")))
	})

	it("keeps concurrent requests apart", async () => {
		const handle = (id: string) =>
			trace.getTracer("framework").startActiveSpan(`request ${id}`, async (span) => {
				await traced(`load ${id}`, async () => {
					await tick()
					trace.getTracer("db").startSpan(`query ${id}`).end()
				})
				span.end()
			})
		await Promise.all([handle("a"), handle("b")])
		for (const id of ["a", "b"]) {
			const load = named(`load ${id}`)
			expect(parentOf(load)).toBe(idOf(named(`request ${id}`)))
			expect(parentOf(named(`query ${id}`))).toBe(idOf(load))
		}
	})

	it("is a root span when no server span is active", async () => {
		await traced("loader", async () => undefined)
		expect(parentOf(named("loader"))).toBeUndefined()
	})

	it("records a throw, marks the span Error and rethrows the same error", async () => {
		const error = new TypeError("loader failed")
		await expect(
			request(() =>
				traced("loader", async () => {
					throw error
				}),
			),
		).rejects.toBe(error)
		const span = named("loader")
		expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "loader failed" })
		expect(span.events.map((event) => event.name)).toEqual(["exception"])
		expect(span.events[0]?.attributes?.["exception.type"]).toBe("TypeError")
		expect(span.events[0]?.attributes?.["exception.stacktrace"]).toBeTypeOf("string")
		expect(span.ended).toBe(true)
	})

	it("turns a synchronous throw into a rejection with the same error", async () => {
		const error = new Error("sync")
		// Not an async function: the throw happens synchronously, inside `traced`
		const fn = (): Promise<never> => {
			throw error
		}
		await expect(traced("loader", fn)).rejects.toBe(error)
		expect(named("loader").status.code).toBe(SpanStatusCode.ERROR)
	})

	it("records an error-like object by its message and rethrows it unchanged", async () => {
		const thrown = { message: "not an Error instance", code: 42 }
		await expect(
			traced("loader", async () => {
				throw thrown
			}),
		).rejects.toBe(thrown)
		expect(named("loader").status.message).toBe("not an Error instance")
		expect(exceptionEvents()[0]?.attributes?.["exception.message"]).toBe("not an Error instance")
	})

	it("records a thrown primitive", async () => {
		await expect(
			traced("loader", async () => {
				throw "plain string"
			}),
		).rejects.toBe("plain string")
		expect(named("loader").status.message).toBe("plain string")
	})

	it("leaves the span Ok and the error unclaimed when isFailure returns false", async () => {
		const redirect = new Error("NEXT_REDIRECT")
		await expect(
			traced(
				"loader",
				async () => {
					throw redirect
				},
				{ isFailure: () => false },
			),
		).rejects.toBe(redirect)
		expect(named("loader").status.code).toBe(SpanStatusCode.UNSET)
		expect(exceptionEvents()).toHaveLength(0)
		// Unclaimed: whatever reports it next still records it
		captureException(redirect)
		expect(exceptionEvents()).toHaveLength(1)
	})

	it("rethrows the original error when isFailure itself throws", async () => {
		const error = new Error("loader failed")
		await expect(
			traced(
				"loader",
				async () => {
					throw error
				},
				{
					isFailure: () => {
						throw new Error("predicate bug")
					},
				},
			),
		).rejects.toBe(error)
		expect(named("loader").status.code).toBe(SpanStatusCode.ERROR)
	})

	it("puts the exception event on the innermost span only when traced calls nest", async () => {
		const error = new Error("inner failed")
		await expect(
			request(() =>
				traced("outer", () =>
					traced("inner", async () => {
						throw error
					}),
				),
			),
		).rejects.toBe(error)
		expect(named("inner").events).toHaveLength(1)
		expect(named("outer").events).toHaveLength(0)
		expect(named("outer").status.code).toBe(SpanStatusCode.ERROR)
	})

	it("records an error object shared by requests on the first only", async () => {
		// A memoized promise's rejection, which every request awaiting it rethrows
		const shared = new Error("service unavailable")
		const fail = () =>
			request(() =>
				traced("loader", async () => {
					throw shared
				}),
			).catch(() => undefined)
		await Promise.all([fail(), fail()])
		expect(exceptionEvents()).toHaveLength(1)
		// Both spans still fail
		expect(spans().filter((span) => span.status.code === SpanStatusCode.ERROR)).toHaveLength(2)
	})

	it("is not reported again by captureException in the same process", async () => {
		const error = new Error("resolver failed")
		await request(() =>
			traced("resolver", async () => {
				throw error
			}),
		).catch(() => undefined)
		captureException(error)
		expect(exceptionEvents()).toHaveLength(1)
	})
})

describe("MapleBrowser.traced on the server", () => {
	beforeEach(registerServerOtel)

	it("spans through the server's tracer, like the /server entry", async () => {
		expect(typeof window).toBe("undefined")
		const value = { ok: true }
		await expect(request(() => MapleBrowser.traced("load project", async () => value))).resolves.toBe(
			value,
		)
		expect(parentOf(named("load project"))).toBe(idOf(named("GET /projects/[id]")))
	})
})

describe("serverTiming", () => {
	it("is undefined without server OpenTelemetry", () => {
		expect(serverTiming()).toBeUndefined()
	})

	describe("with server OpenTelemetry", () => {
		beforeEach(registerServerOtel)

		it("carries the active span's context", async () => {
			await request(async (span) => {
				const { traceId, spanId } = span.spanContext()
				expect(serverTiming()).toBe(`traceparent;desc="00-${traceId}-${spanId}-01"`)
			})
		})

		it("names the innermost active span, across await", async () => {
			const value = await request(() =>
				traced("render", async () => {
					await tick()
					return serverTiming()
				}),
			)
			const render = named("render")
			expect(value).toBe(`traceparent;desc="00-${render.spanContext().traceId}-${idOf(render)}-01"`)
		})

		it("keeps an unsampled trace unsampled", () => {
			const spanContext = {
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				traceFlags: TraceFlags.NONE,
			}
			context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), () => {
				expect(serverTiming()).toBe(
					'traceparent;desc="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00"',
				)
			})
		})

		it("is undefined when no span is active", () => {
			expect(serverTiming()).toBeUndefined()
		})

		it("is undefined for an invalid span context", () => {
			context.with(trace.setSpanContext(ROOT_CONTEXT, INVALID_SPAN_CONTEXT), () => {
				expect(serverTiming()).toBeUndefined()
			})
			const malformed = { traceId: 'x"; injected', spanId: "b7ad6b7169203331", traceFlags: 1 }
			context.with(trace.setSpanContext(ROOT_CONTEXT, malformed), () => {
				expect(serverTiming()).toBeUndefined()
			})
		})
	})
})
