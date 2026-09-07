/**
 * Maple's stateless Streamable HTTP transport for MCP.
 *
 * Effect's `McpServer.layerHttp` keeps negotiated sessions in a Map created per
 * layer build — per isolate on Workers — and answers any request carrying a
 * session id it does not hold with a bare 404. A session issued by one isolate
 * is therefore unusable from the next, which is every request after
 * `initialize` on a Worker. The map is also never pruned on the HTTP path, so
 * each `initialize` leaks its session for the isolate's life.
 *
 * This transport keeps Effect's MCP server — the tools, prompts, resources and
 * protocol adapters are all still its own — and replaces only the seam that
 * carries sessions: `RpcServer.Protocol` plus the route that feeds it. Each
 * request is self-contained. When a client sends anything other than
 * `initialize`, we drive a synthetic `initialize` on the same ephemeral client
 * first, so the server has the negotiated profile it needs, and drop its reply
 * before answering.
 *
 * The server itself is run with `HttpRouter` omitted from its context, which is
 * the whole trick: `isHttp` is `serviceOption(HttpRouter)`, so without it the
 * server files sessions under the client id — which the disconnect finalizer
 * deletes when the request scope closes — instead of under a session id, which
 * nothing ever deletes, and it reads headers off the message rather than the
 * live request. No `mcp-session-id` is issued, so clients never send one back
 * and the 404 branch cannot be reached. See `statelessMcpServerLayer`.
 */
import { Cause, Context, Effect, Fiber, Layer, Predicate, Queue, Scope } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import {
	constEof,
	type FromClientEncoded,
	type FromServerEncoded,
	RequestId,
	type RequestEncoded,
} from "effect/unstable/rpc/RpcMessage"

/**
 * JSON-RPC id for the `initialize` this transport synthesises. Namespaced so it
 * cannot collide with a client's own id, and matched again on the way out to
 * drop the reply the client never asked for.
 */
const SYNTHETIC_INITIALIZE_ID = "__maple/mcp/synthetic-initialize"

/**
 * Client identity reported for a synthesised handshake. It is Maple's own
 * transport talking, not the caller — the caller's identity travels on the
 * credential, which the authorization middleware has already resolved.
 */
const SYNTHETIC_CLIENT_INFO = { name: "maple-stateless-transport", version: "1" }

const syntheticInitialize = (protocolVersion: string) => ({
	jsonrpc: "2.0",
	id: SYNTHETIC_INITIALIZE_ID,
	method: "initialize",
	params: {
		protocolVersion,
		capabilities: {},
		clientInfo: SYNTHETIC_CLIENT_INFO,
	},
})

/**
 * Drops the live request from a context that does not require it, which is the
 * signature that keeps `R` at `never` rather than widening it to `unknown`.
 */
const omitRequest = (context: Context.Context<never>): Context.Context<never> =>
	Context.omit(HttpServerRequest.HttpServerRequest)(context)

/**
 * Drops the router from the server's context. It is ambient rather than one of
 * the server's own requirements, so deleting it leaves those requirements — and
 * the effect's `R` — unchanged.
 */
const omitRouter = (
	context: Context.Context<McpServer.McpServer | RpcServer.Protocol>,
): Context.Context<McpServer.McpServer | RpcServer.Protocol> => Context.omit(HttpRouter.HttpRouter)(context)

const isInitializeMessage = (message: FromClientEncoded): boolean =>
	message._tag === "Request" && message.tag === "initialize"

const jsonRpcError = (id: string | number | null, code: number, message: string) =>
	HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, error: { code, message } })

/** Media types a `content-type` / `accept` header offers, parameters stripped. */
const mediaTypes = (header: string | undefined): ReadonlyArray<string> =>
	header === undefined ? [] : header.split(",").map((part) => part.split(";")[0]!.trim().toLowerCase())

/**
 * Mirrors Effect's origin check: a request without an `Origin` is a non-browser
 * client and allowed, anything else must be on the allowlist.
 */
const isAllowedOrigin = (
	request: HttpServerRequest.HttpServerRequest,
	allowedOrigins: ReadonlyArray<string> | undefined,
): boolean => {
	const origin = request.headers["origin"]
	return origin === undefined || (allowedOrigins ?? []).includes(origin)
}

/**
 * The `RpcServer.Protocol` behind `McpServer.layer`, plus the POST route that
 * drives it. Modelled on `RpcServer.makeProtocolWithHttpEffect`, with the
 * session handling replaced by the synthetic handshake described above.
 */
export const layerStatelessMcpHttp = (options: {
	readonly path: HttpRouter.PathInput
	/** The revision served; its version seeds the synthetic handshake and its
	 * transport says whether JSON-RPC batches are accepted at all. */
	readonly protocol: McpProtocol.ProtocolAdapter
	readonly allowedOrigins?: ReadonlyArray<string> | undefined
}): Layer.Layer<RpcServer.Protocol, never, RpcSerialization.RpcSerialization | HttpRouter.HttpRouter> =>
	Layer.effect(RpcServer.Protocol)(
		Effect.gen(function* () {
			const serialization = yield* RpcSerialization.RpcSerialization
			const router = yield* HttpRouter.HttpRouter

			const disconnects = yield* Queue.make<number>()
			let writeRequest!: (clientId: number, message: FromClientEncoded) => Effect.Effect<void>
			let clientId = 0

			type Client = {
				readonly write: (response: FromServerEncoded) => Effect.Effect<void>
				readonly end: Effect.Effect<void>
			}
			const clients = new Map<number, Client>()
			const clientIds = new Set<number>()

			/**
			 * One HTTP POST: an ephemeral RPC client, the synthetic handshake when
			 * the body does not carry its own, then the client's messages.
			 */
			const httpEffect: Effect.Effect<
				HttpServerResponse.HttpServerResponse,
				never,
				Scope.Scope | HttpServerRequest.HttpServerRequest
			> = Effect.gen(function* () {
				const fiber = Fiber.getCurrent()!
				const request = Context.getUnsafe(fiber.context, HttpServerRequest.HttpServerRequest)
				const scope = Context.getUnsafe(fiber.context, Scope.Scope)
				const requestHeaders = Object.entries(request.headers)
				const body = yield* Effect.orDie(request.text)

				const id = clientId++
				const queue = yield* Queue.make<FromServerEncoded, Cause.Done>()
				const requestIds: Array<RequestId> = []

				const client: Client = {
					// Notifications cannot ride a buffered JSON-RPC response, so they
					// are dropped exactly as Effect's own buffered client does.
					write: (response) =>
						response._tag === "Request" && response.isNotification === true
							? Effect.void
							: Queue.offer(queue, response),
					end: Queue.end(queue),
				}

				yield* Scope.addFinalizerExit(scope, () => {
					clients.delete(id)
					clientIds.delete(id)
					Queue.offerUnsafe(disconnects, id)
					if (queue.state._tag === "Done") return Effect.void
					return Effect.forEach(
						requestIds,
						(requestId) => writeRequest(id, { _tag: "Interrupt", requestId }),
						{ discard: true },
					)
				})
				clients.set(id, client)
				clientIds.add(id)

				// The server is already running without `HttpRouter`; keeping the live
				// request out of the handler's context too is the other half of that
				// choice — `initialize` checks for it separately, and finding one is
				// what makes it mint a session id instead of filing the session under
				// this client. Everything the handlers need from the request travels
				// on the messages themselves, as `requestHeaders` below.
				const write = (message: FromClientEncoded) =>
					Effect.updateContext(writeRequest(id, message), omitRequest)

				const parser = serialization.makeUnsafe()

				const decoded = yield* Effect.try({
					try: () => parser.decode(body) as ReadonlyArray<FromClientEncoded>,
					catch: (cause) => cause,
				}).pipe(Effect.option)
				if (decoded._tag === "None") {
					return jsonRpcError(null, -32700, "Parse error")
				}
				const messages = decoded.value
				if (messages.length > 1 && !options.protocol.transport.acceptsJsonRpcBatches) {
					return HttpServerResponse.empty({ status: 400 })
				}

				// The handshake the client did not send, so the server has a negotiated
				// profile for this exchange.
				if (!messages.some(isInitializeMessage)) {
					const synthetic = parser.decode(
						JSON.stringify(syntheticInitialize(options.protocol.protocolVersion)),
					) as ReadonlyArray<FromClientEncoded>
					for (const message of synthetic) {
						yield* write(message)
					}
				}

				for (const message of messages) {
					if (message._tag === "Request") {
						requestIds.push(RequestId(message.id))
						;(message as RequestEncoded & { headers: typeof requestHeaders }).headers =
							requestHeaders.concat(message.headers)
					}
					yield* write(message)
				}

				yield* write(constEof)

				const responses = yield* Queue.collect(queue)
				// The synthetic handshake is Maple's, not the caller's; its reply must
				// not reach the wire.
				const visible = responses.filter(
					(response) =>
						!(
							Predicate.hasProperty(response, "requestId") &&
							response.requestId === SYNTHETIC_INITIALIZE_ID
						),
				)
				return HttpServerResponse.text(parser.encode(visible) as string, {
					contentType: serialization.contentType,
				})
			})

			yield* router.add("POST", options.path, (request) => {
				if (!isAllowedOrigin(request, options.allowedOrigins)) {
					return Effect.succeed(HttpServerResponse.empty({ status: 403 }))
				}
				if (mediaTypes(request.headers["content-type"])[0] !== "application/json") {
					return Effect.succeed(HttpServerResponse.empty({ status: 415 }))
				}
				const accepted = mediaTypes(request.headers["accept"])
				if (!accepted.includes("application/json") || !accepted.includes("text/event-stream")) {
					return Effect.succeed(HttpServerResponse.empty({ status: 406 }))
				}
				return httpEffect
			})

			const methodNotAllowed = (request: HttpServerRequest.HttpServerRequest) =>
				isAllowedOrigin(request, options.allowedOrigins)
					? Effect.succeed(HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } }))
					: Effect.succeed(HttpServerResponse.empty({ status: 403 }))
			for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
				yield* router.add(method, options.path, methodNotAllowed)
			}

			return yield* RpcServer.Protocol.make((writeRequest_) => {
				writeRequest = writeRequest_
				return Effect.succeed({
					disconnects,
					send: (targetClientId: number, response: FromServerEncoded) => {
						const client = clients.get(targetClientId)
						return client ? client.write(response) : Effect.void
					},
					end: (targetClientId: number) => {
						const client = clients.get(targetClientId)
						return client ? client.end : Effect.void
					},
					clientIds: Effect.sync(() => clientIds),
					initialMessage: Effect.succeedNone,
					supportsAck: false,
					supportsTransferables: false,
					supportsSpanPropagation: false,
					supportsNotifications: false,
				})
			})
		}),
	)

/**
 * The MCP server, run with `HttpRouter` omitted from its context.
 *
 * `isHttp` inside the server is `serviceOption(HttpRouter)`, and it decides
 * where a negotiated session is filed: with a router in scope, under a freshly
 * minted session id that nothing ever deletes; without one, under the RPC client
 * id, which the disconnect finalizer releases with the request. This transport
 * wants the second, so the router — which `layerStatelessMcpHttp` still needs to
 * register its route — is kept out of the server's own context.
 */
export const statelessMcpServerLayer = (options: {
	readonly name: string
	readonly version: string
	readonly protocols: readonly [McpProtocol.ProtocolAdapter, ...Array<McpProtocol.ProtocolAdapter>]
}) =>
	Layer.effectDiscard(Effect.forkScoped(Effect.updateContext(McpServer.run(options), omitRouter))).pipe(
		Layer.provideMerge(McpServer.McpServer.layer),
	)
