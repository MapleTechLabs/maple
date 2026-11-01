import { describe, expect, it } from "@effect/vitest"
import type { FromClientEncoded } from "effect/rpc/RpcMessage"
import { mcpServerSpan, withMetaTraceContext } from "./span-conventions"

const request = (tag: string, payload: unknown) =>
	({ _tag: "Request", id: "7", tag, payload, headers: [] }) as const

const caller = { userAgent: undefined, clientAddress: undefined }

describe("mcpServerSpan", () => {
	it("names a prompt span after the prompt", () => {
		const span = mcpServerSpan(request("prompts/get", { name: "debug-errors" }), "2025-06-18", caller)
		expect(span.name).toBe("prompts/get debug-errors")
		expect(span.attributes.get("gen_ai.prompt.name")).toBe("debug-errors")
		expect(span.attributes.get("gen_ai.operation.name")).toBeUndefined()
	})

	it("keeps a resource URI out of the span name", () => {
		const span = mcpServerSpan(
			request("resources/read", { uri: "maple://instructions" }),
			"2025-06-18",
			caller,
		)
		expect(span.name).toBe("resources/read")
		expect(span.attributes.get("mcp.resource.uri")).toBe("maple://instructions")
	})

	it("falls back to the method when a tool call has no name", () => {
		const span = mcpServerSpan(request("tools/call", { arguments: {} }), "2025-06-18", caller)
		expect(span.name).toBe("tools/call")
		expect(span.attributes.get("gen_ai.tool.name")).toBeUndefined()
		expect(span.attributes.get("gen_ai.operation.name")).toBe("execute_tool")
	})
})

describe("withMetaTraceContext", () => {
	const traced = (message: FromClientEncoded) => {
		const result = withMetaTraceContext(message)
		return result._tag === "Request" ? { traceId: result.traceId, spanId: result.spanId } : undefined
	}

	it("ignores a malformed traceparent", () => {
		expect(
			traced(request("tools/call", { name: "x", _meta: { traceparent: "not-a-traceparent" } })),
		).toEqual({
			traceId: undefined,
			spanId: undefined,
		})
	})

	it("drops trace fields set at the top level of the JSON-RPC body", () => {
		const spoofed = {
			...request("tools/call", { name: "x" }),
			traceId: "abc",
			spanId: "zz",
			sampled: false,
		}
		expect(traced(spoofed)).toEqual({ traceId: undefined, spanId: undefined })
	})

	it("takes the caller's span from a valid traceparent", () => {
		const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
		expect(traced(request("tools/call", { name: "x", _meta: { traceparent } }))).toEqual({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "00f067aa0ba902b7",
		})
	})

	it("ignores a request without _meta", () => {
		expect(traced(request("tools/list", {}))).toEqual({ traceId: undefined, spanId: undefined })
	})
})
