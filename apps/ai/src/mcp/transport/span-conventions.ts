/**
 * Maple's attributes on the OpenTelemetry MCP server span (https://semconv.com/domains/mcp).
 * Effect's `McpServer` opens that span per message, already spec-named (`<method>` or
 * `<method> <target>`) with the `mcp.*` attributes and its parent from `params._meta`. The
 * transport wraps each message's tracer to add who called, and to drop the synthesised handshake.
 */
import { Option, Predicate, Tracer, Array as Arr, String as Str } from "effect"
import { Headers, HttpTraceContext } from "effect/http"
import type { HttpServerRequest } from "effect/http"
import type { FromClientEncoded } from "effect/rpc/RpcMessage"

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
/** A spec version is a date; anything else the caller sends is not recorded. */
const SPEC_VERSION = /^\d{4}-\d{2}-\d{2}$/
/** `clientInfo` is the caller's free text, now on every request: bound what reaches the span. */
const CLIENT_INFO_MAX = 128

const metaVersion = (meta: unknown): string | undefined => {
	const version = stringField(meta, META_PROTOCOL_VERSION)
	return version !== undefined && SPEC_VERSION.test(version) ? version : undefined
}

/** What the HTTP request knows about the caller, for every message it carries. */
export interface McpCaller {
	readonly userAgent: string | undefined
	readonly clientAddress: string | undefined
	/** The signed-in user the request's credential belongs to: the hub builds sessions from it. */
	readonly userId: string | undefined
	/** The org the credential acts for: without it, usage cannot be split by customer. */
	readonly orgId: string | undefined
}

export const mcpCaller = (
	request: HttpServerRequest.HttpServerRequest,
	userId: string | undefined,
	orgId: string | undefined,
): McpCaller => ({
	userAgent: request.headers["user-agent"],
	clientAddress: Option.getOrUndefined(request.remoteAddress),
	userId,
	orgId,
})

const stringField = (value: unknown, key: string): string | undefined => {
	if (!Predicate.hasProperty(value, key)) return undefined
	const field = value[key]
	return Predicate.isString(field) ? field : undefined
}

/**
 * The caller's span from `params._meta` (unprefixed `traceparent`, SEP-414), and
 * only from there: Effect's JSON-RPC decoder also copies unvalidated top-level
 * `traceId`/`spanId`/`sampled` from the body, which are always dropped. Always
 * sampled: Maple records its own server whatever the caller decided.
 */
export const withMetaTraceContext = (message: FromClientEncoded): FromClientEncoded => {
	if (message._tag !== "Request") return message
	const { traceId: _traceId, spanId: _spanId, sampled: _sampled, ...untraced } = message
	const meta = Predicate.hasProperty(message.payload, "_meta") ? message.payload._meta : undefined
	const traceparent = stringField(meta, "traceparent")
	if (traceparent === undefined) return untraced
	return Option.match(HttpTraceContext.w3c(Headers.fromInput({ traceparent })), {
		onNone: () => untraced,
		onSome: (parent) => ({ ...untraced, traceId: parent.traceId, spanId: parent.spanId, sampled: true }),
	})
}

/** Spec name and attributes for one request's server span. */
export interface McpServerSpan {
	readonly name: string
	readonly attributes: ReadonlyMap<string, string>
}

export const mcpServerSpan = (
	message: FromClientEncoded & { readonly _tag: "Request" },
	protocolVersion: string | undefined,
	caller: McpCaller,
): McpServerSpan => {
	const method = message.tag
	const payload = message.payload
	// Stateless MCP (2026-07-28) sends the version and `clientInfo` on every request, in `_meta`.
	const meta = Predicate.hasProperty(payload, "_meta") ? payload._meta : undefined
	const attributes = new Map([
		["mcp.method.name", method],
		["jsonrpc.request.id", String(message.id)],
		["network.transport", "tcp"],
		["network.protocol.name", "http"],
	])
	const version = metaVersion(meta) ?? protocolVersion
	if (version !== undefined) attributes.set("mcp.protocol.version", version)
	if (caller.userAgent !== undefined) attributes.set("user_agent.original", caller.userAgent)
	if (caller.clientAddress !== undefined) attributes.set("client.address", caller.clientAddress)
	if (caller.userId !== undefined) attributes.set("user.id", caller.userId)
	if (caller.orgId !== undefined) attributes.set("maple.org_id", caller.orgId)
	// The spec has no client-identity attribute; `clientInfo` rides on `initialize`, or per request.
	const clientInfo = Predicate.hasProperty(payload, "clientInfo")
		? payload.clientInfo
		: Predicate.hasProperty(meta, META_CLIENT_INFO)
			? meta[META_CLIENT_INFO]
			: undefined
	const clientName = stringField(clientInfo, "name")
	const clientVersion = stringField(clientInfo, "version")
	if (clientName !== undefined)
		attributes.set("maple.mcp.client.name", Str.slice(0, CLIENT_INFO_MAX)(clientName))
	if (clientVersion !== undefined)
		attributes.set("maple.mcp.client.version", Str.slice(0, CLIENT_INFO_MAX)(clientVersion))

	let target: string | undefined
	switch (method) {
		case "tools/call":
			target = stringField(payload, "name")
			attributes.set("gen_ai.operation.name", "execute_tool")
			if (target !== undefined) attributes.set("gen_ai.tool.name", target)
			break
		case "prompts/get":
			target = stringField(payload, "name")
			if (target !== undefined) attributes.set("gen_ai.prompt.name", target)
			break
		case "resources/read":
		case "resources/subscribe":
		case "resources/unsubscribe": {
			// The URI is high-cardinality: an attribute, never part of the name.
			const uri = stringField(payload, "uri")
			if (uri !== undefined) attributes.set("mcp.resource.uri", uri)
			break
		}
	}
	return { name: target === undefined ? method : `${method} ${target}`, attributes }
}

/**
 * A tracer for one message: its MCP server span gains the caller's attributes or,
 * for the handshake the transport synthesises, is not recorded at all. Every
 * other span passes through untouched.
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
			// `McpServer` names the span `<method>` or `<method> <target>`, and sets its
			// own `mcp.*` attributes only after the tracer has made it.
			const isMcpServerSpan =
				spanOptions.kind === "server" &&
				(spanOptions.name === message.tag || Str.startsWith(`${message.tag} `)(spanOptions.name))
			if (!isMcpServerSpan) return base.span(spanOptions)
			if (options.synthetic) return base.span({ ...spanOptions, sampled: false })
			const conventions = mcpServerSpan(message, undefined, caller)
			// The HTTP span is never also a link when it is already the parent.
			const links = Option.match(spanOptions.parent, {
				onNone: () => spanOptions.links,
				onSome: (parent) =>
					Arr.filter(spanOptions.links, (link) => link.span.spanId !== parent.spanId),
			})
			// Sampled whatever the caller's `_meta` parent decided: Maple records its own server.
			const span = base.span({ ...spanOptions, name: conventions.name, links, sampled: true })
			conventions.attributes.forEach((value, key) => span.attribute(key, value))
			return span
		},
		context: base.context,
	})
}
