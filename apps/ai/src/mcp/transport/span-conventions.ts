/**
 * The OpenTelemetry MCP conventions (https://semconv.com/domains/mcp) on the
 * server span Effect's `RpcServer` opens for each message. That span is named
 * `McpServer.@effect/mcp/<version>/<method>` and carries only `rpc.*`; the
 * transport wraps each message's tracer so the span is born with the spec name
 * and attributes instead, and takes its parent from `params._meta`.
 */
import { Option, Predicate, Tracer } from "effect"
import { Headers, HttpTraceContext } from "effect/http"
import type { HttpServerRequest } from "effect/http"
import type { FromClientEncoded } from "effect/rpc/RpcMessage"

const RPC_SERVER_SPAN = /^McpServer\.@effect\/mcp\/([^/]+)\/(.+)$/

/** What the HTTP request knows about the caller, for every message it carries. */
export interface McpCaller {
	readonly userAgent: string | undefined
	readonly clientAddress: string | undefined
}

export const mcpCaller = (request: HttpServerRequest.HttpServerRequest): McpCaller => ({
	userAgent: request.headers["user-agent"],
	clientAddress: Option.getOrUndefined(request.remoteAddress),
})

const stringField = (value: unknown, key: string): string | undefined => {
	if (!Predicate.hasProperty(value, key)) return undefined
	const field = value[key]
	return Predicate.isString(field) ? field : undefined
}

const metaOf = (message: FromClientEncoded): unknown =>
	message._tag === "Request" && Predicate.hasProperty(message.payload, "_meta")
		? message.payload._meta
		: undefined

/**
 * The caller's span from `params._meta` (unprefixed `traceparent`, SEP-414).
 * Always sampled: Maple records its own server whatever the caller decided.
 */
export const withMetaTraceContext = (message: FromClientEncoded): FromClientEncoded => {
	if (message._tag !== "Request") return message
	const traceparent = stringField(metaOf(message), "traceparent")
	if (traceparent === undefined) return message
	return Option.match(HttpTraceContext.w3c(Headers.fromInput({ traceparent })), {
		onNone: () => message,
		onSome: (parent) => ({ ...message, traceId: parent.traceId, spanId: parent.spanId, sampled: true }),
	})
}

/** Spec name and attributes for one request's server span. */
export const mcpServerSpan = (
	message: FromClientEncoded & { readonly _tag: "Request" },
	protocolVersion: string,
	caller: McpCaller,
): { readonly name: string; readonly attributes: Readonly<Record<string, string>> } => {
	const method = message.tag
	const attributes: Record<string, string> = {
		"mcp.method.name": method,
		"mcp.protocol.version": protocolVersion,
		"jsonrpc.request.id": String(message.id),
		"network.transport": "tcp",
		"network.protocol.name": "http",
	}
	if (caller.userAgent !== undefined) attributes["user_agent.original"] = caller.userAgent
	if (caller.clientAddress !== undefined) attributes["client.address"] = caller.clientAddress

	const payload = message.payload
	let target: string | undefined
	switch (method) {
		case "tools/call":
			target = stringField(payload, "name")
			attributes["gen_ai.operation.name"] = "execute_tool"
			if (target !== undefined) attributes["gen_ai.tool.name"] = target
			break
		case "prompts/get":
			target = stringField(payload, "name")
			if (target !== undefined) attributes["gen_ai.prompt.name"] = target
			break
		case "resources/read":
		case "resources/subscribe":
		case "resources/unsubscribe": {
			// The URI is high-cardinality: an attribute, never part of the name.
			const uri = stringField(payload, "uri")
			if (uri !== undefined) attributes["mcp.resource.uri"] = uri
			break
		}
		case "initialize": {
			// The spec has no client-identity attribute; `clientInfo` only exists here.
			const clientInfo = Predicate.hasProperty(payload, "clientInfo") ? payload.clientInfo : undefined
			const name = stringField(clientInfo, "name")
			const version = stringField(clientInfo, "version")
			if (name !== undefined) attributes["maple.mcp.client.name"] = name
			if (version !== undefined) attributes["maple.mcp.client.version"] = version
			break
		}
	}
	return { name: target === undefined ? method : `${method} ${target}`, attributes }
}

/**
 * A tracer for one message: its `RpcServer` span is renamed and annotated, or,
 * for the handshake the transport synthesises, not recorded at all. Every other
 * span passes through untouched.
 */
export const mcpMessageTracer = (
	base: Tracer.Tracer,
	message: FromClientEncoded,
	caller: McpCaller,
	options: { readonly synthetic: boolean },
): Tracer.Tracer => {
	if (message._tag !== "Request") return base
	return Tracer.make({
		span(spanOptions) {
			const match = RPC_SERVER_SPAN.exec(spanOptions.name)
			if (match === null || match[2] !== message.tag || spanOptions.kind !== "server") {
				return base.span(spanOptions)
			}
			if (options.synthetic) return base.span({ ...spanOptions, sampled: false })
			const conventions = mcpServerSpan(message, match[1] ?? "", caller)
			const span = base.span({ ...spanOptions, name: conventions.name })
			for (const [key, value] of Object.entries(conventions.attributes)) span.attribute(key, value)
			return span
		},
		context: base.context,
	})
}
