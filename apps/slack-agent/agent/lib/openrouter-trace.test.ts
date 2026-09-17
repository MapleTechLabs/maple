import { afterEach, describe, expect, test } from "bun:test"
import { installFetchStub, type FetchStub } from "./fetch-stub.js"
import { openRouterFetch } from "./openrouter-trace.js"
import { withActiveSpan } from "./test-span.js"

let stub: FetchStub | undefined

afterEach(() => {
	stub?.restore()
	stub = undefined
})

const URL = "https://openrouter.ai/api/v1/chat/completions"
const post = (body: string) => openRouterFetch(URL, { method: "POST", body })

const sent = (index = 0): Record<string, unknown> => {
	const body = stub?.calls[index]?.body
	if (typeof body !== "string") throw new Error("no request reached the transport")
	// SAFETY: the test posted a JSON object below and reads its keys one at a time.
	return JSON.parse(body) as Record<string, unknown>
}

describe("openRouterFetch", () => {
	test("stamps the active span's ids into the request's trace object", async () => {
		stub = installFetchStub(() => new Response("{}"))
		const ids = await withActiveSpan("ai.streamText.doStream", async (ids) => {
			await post(JSON.stringify({ model: "m", trace: { trace_name: "slack" } }))
			return ids
		})
		expect(sent().trace).toEqual({
			trace_name: "slack",
			trace_id: ids.traceId,
			parent_span_id: ids.spanId,
		})
		expect(sent().model).toBe("m")
	})

	test("each call carries its own span, not the first one's", async () => {
		stub = installFetchStub(() => new Response("{}"))
		const first = await withActiveSpan("call 1", async (ids) => {
			await post(JSON.stringify({ model: "m" }))
			return ids
		})
		const second = await withActiveSpan("call 2", async (ids) => {
			await post(JSON.stringify({ model: "m" }))
			return ids
		})
		expect(first.spanId).not.toBe(second.spanId)
		expect(sent(0).trace).toEqual({ trace_id: first.traceId, parent_span_id: first.spanId })
		expect(sent(1).trace).toEqual({ trace_id: second.traceId, parent_span_id: second.spanId })
	})

	test("leaves the request alone when no span is active", async () => {
		stub = installFetchStub(() => new Response("{}"))
		await post(JSON.stringify({ model: "m", trace: { trace_name: "slack" } }))
		expect(sent().trace).toEqual({ trace_name: "slack" })
	})

	test("passes a body that is not a JSON object through untouched", async () => {
		stub = installFetchStub(() => new Response("{}"))
		await withActiveSpan("ai.streamText.doStream", async () => {
			await post("not json")
			await post("[1]")
		})
		expect(stub.calls[0]?.body).toBe("not json")
		expect(stub.calls[1]?.body).toBe("[1]")
	})
})
