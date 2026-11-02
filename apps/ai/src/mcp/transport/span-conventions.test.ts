import { describe, expect, it } from "@effect/vitest"
import type { FromClientEncoded } from "effect/rpc/RpcMessage"
import { mcpServerSpan, withMetaTraceContext } from "./span-conventions"

const request = (tag: string, payload: unknown) =>
	({ _tag: "Request", id: "7", tag, payload, headers: [] }) as const

const caller = { userAgent: undefined, clientAddress: undefined, userId: undefined }

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

	it("names the signed-in user, so a stateless server's calls still group into sessions", () => {
		const span = mcpServerSpan(request("tools/call", { name: "run_sql" }), "2025-06-18", {
			...caller,
			userId: "user_2abc",
		})
		expect(span.attributes.get("user.id")).toBe("user_2abc")
		expect(
			mcpServerSpan(request("tools/call", { name: "run_sql" }), "2025-06-18", caller).attributes.has(
				"user.id",
			),
		).toBe(false)
	})

	it("names the client from initialize, or from each request's _meta on a stateless server", () => {
		const handshake = mcpServerSpan(
			request("initialize", { clientInfo: { name: "claude-code", version: "2.1.0" } }),
			"2025-06-18",
			caller,
		)
		expect(handshake.attributes.get("maple.mcp.client.name")).toBe("claude-code")
		expect(handshake.attributes.get("maple.mcp.client.version")).toBe("2.1.0")

		const call = mcpServerSpan(
			request("tools/call", {
				name: "run_sql",
				_meta: {
					"io.modelcontextprotocol/clientInfo": { name: "cursor", version: "1.4" },
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				},
			}),
			"2025-06-18",
			caller,
		)
		expect(call.attributes.get("maple.mcp.client.name")).toBe("cursor")
		expect(call.attributes.get("maple.mcp.client.version")).toBe("1.4")
		expect(call.attributes.get("mcp.protocol.version")).toBe("2026-07-28")
		expect(
			mcpServerSpan(request("tools/call", { name: "run_sql" }), "2025-06-18", caller).attributes.has(
				"maple.mcp.client.name",
			),
		).toBe(false)
	})

	it("keeps the negotiated version unless _meta sends a spec version", () => {
		const version = (payload: Record<string, unknown>) =>
			mcpServerSpan(
				request("tools/call", { name: "run_sql", ...payload }),
				"2025-06-18",
				caller,
			).attributes.get("mcp.protocol.version")
		expect(version({})).toBe("2025-06-18")
		expect(version({ _meta: { "io.modelcontextprotocol/protocolVersion": "latest; drop table" } })).toBe(
			"2025-06-18",
		)
	})

	it("prefers initialize's clientInfo and bounds what a caller sends", () => {
		const span = mcpServerSpan(
			request("initialize", {
				clientInfo: { name: "claude-code" },
				_meta: { "io.modelcontextprotocol/clientInfo": { name: "cursor" } },
			}),
			"2025-06-18",
			caller,
		)
		expect(span.attributes.get("maple.mcp.client.name")).toBe("claude-code")
		const long = mcpServerSpan(
			request("tools/call", {
				name: "run_sql",
				_meta: { "io.modelcontextprotocol/clientInfo": { name: "x".repeat(5_000) } },
			}),
			"2025-06-18",
			caller,
		)
		expect(long.attributes.get("maple.mcp.client.name")).toHaveLength(128)
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
