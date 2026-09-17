import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { context, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { installFetchStub, type FetchStub } from "./fetch-stub.js"
import { openRouterFetch } from "./openrouter-trace.js"

/** A tracer whose spans are active across `await`, the way the OTel Node SDK's are in production. */
export const withActiveSpan = async <A>(
	name: string,
	fn: (ids: { traceId: string; spanId: string }) => Promise<A>,
) =>
	new BasicTracerProvider().getTracer("test").startActiveSpan(name, async (span) => {
		try {
			return await fn(span.spanContext())
		} finally {
			span.end()
		}
	})

let stub: FetchStub | undefined

beforeAll(() => {
	// A second registration in the same process is refused, harmlessly: the first one is ours too.
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
})

afterEach(() => {
	stub?.restore()
	stub = undefined
})

const sent = (): Record<string, unknown> => {
	const body = stub?.calls[0]?.body
	if (typeof body !== "string") throw new Error("no request reached the transport")
	// SAFETY: the test posted a JSON object below and reads its keys one at a time.
	return JSON.parse(body) as Record<string, unknown>
}

describe("openRouterFetch", () => {
	test("stamps the active span's ids into the request's trace object", async () => {
		stub = installFetchStub(() => new Response("{}"))
		const ids = await withActiveSpan("ai.streamText.doStream", async (ids) => {
			await openRouterFetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "m", trace: { trace_name: "slack" } }),
			})
			return ids
		})
		expect(sent().trace).toEqual({
			trace_name: "slack",
			trace_id: ids.traceId,
			parent_span_id: ids.spanId,
		})
		expect(sent().model).toBe("m")
	})

	test("leaves the request alone when no span is active", async () => {
		stub = installFetchStub(() => new Response("{}"))
		await openRouterFetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", trace: { trace_name: "slack" } }),
		})
		expect(sent().trace).toEqual({ trace_name: "slack" })
	})

	test("passes a body that is not JSON through untouched", async () => {
		stub = installFetchStub(() => new Response("{}"))
		await withActiveSpan("ai.streamText.doStream", async () => {
			await openRouterFetch("https://example.com", { method: "POST", body: "not json" })
		})
		expect(stub.calls[0]?.body).toBe("not json")
	})
})
