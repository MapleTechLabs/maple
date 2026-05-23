/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `Rpc` module defines the typed declaration for a single remote
 * procedure. An RPC definition is the shared contract used by `RpcGroup`,
 * clients, and servers: it stores the procedure tag, payload schema, success
 * schema, error schema, defect schema, middleware, annotations, and the type
 * information needed to derive client calls and server handler signatures.
 *
 * Use this module to declare request/response procedures with {@link make},
 * build custom constructors that transform success and error schemas with
 * {@link custom}, add middleware or annotations to individual procedures, and
 * derive helper types such as {@link Payload}, {@link Success},
 * {@link Error}, and {@link ToHandlerFn}. Server implementations can also use
 * {@link fork} and {@link uninterruptible} wrappers to control how handler
 * results are executed.
 *
 * **Schema gotchas**
 *
 * - Payloads default to `Schema.Void`; passing struct fields creates a
 *   `Schema.Struct`, while `primaryKey` creates a payload class with a derived
 *   `PrimaryKey`
 * - Success values default to `Schema.Void`, ordinary errors default to
 *   `Schema.Never`, and middleware errors are included in the effective RPC
 *   error channel
 * - Streaming RPCs store the element and stream error schemas in
 *   `RpcSchema.Stream`; the immediate exit success is `void` and the normal
 *   RPC error schema is set to `Schema.Never`
 * - Defects use a separate defect schema, defaulting to `Schema.Defect`; custom
 *   defect schemas must not require decoding or encoding services
 * - Schema services are directional: clients encode payloads and decode
 *   responses, while servers decode payloads and encode responses
 *
 * @since 4.0.0
 */
export * as Rpc from "./Rpc.ts"

/**
 * Client-side support for calling RPCs defined in an `RpcGroup`.
 *
 * This module derives typed client APIs from RPC definitions, turns method
 * calls into request messages, and routes server responses back to the waiting
 * `Effect` or `Stream`. Use it to construct schema-aware clients over the
 * provided HTTP, socket, and worker transports, or use `makeNoSerialization`
 * when an already-decoded message channel should participate in the same
 * request, interruption, acknowledgement, and streaming lifecycle.
 *
 * The `make` constructor requires a `Protocol`, which owns the encoded
 * transport. HTTP sends one request per call and does not support client
 * acknowledgements, while socket and worker protocols keep receive loops alive,
 * support streaming acknowledgements, and can fail in-flight requests with
 * protocol errors. Streaming RPCs return `Stream`s by default, or scoped
 * queues when `asQueue` is enabled, so `streamBufferSize` controls the client
 * side of streaming back pressure.
 *
 * Payloads, exits, and stream chunks are encoded and decoded through the RPC
 * schemas with the active `RpcSerialization`; any schema services required by
 * those codecs remain part of the generated client method environments.
 * Client middleware declared on an RPC is looked up from
 * `Rpc.MiddlewareClient`, can rewrite or short-circuit outgoing requests, and
 * contributes its client error type to the call signature. Outgoing request
 * headers combine `CurrentHeaders` with per-call headers before the request is
 * passed through middleware and then to the transport.
 *
 * @since 4.0.0
 */
export * as RpcClient from "./RpcClient.ts"

/**
 * Shared error types for the RPC client protocol layer.
 *
 * This module defines the client-side failures added to schema-aware RPC
 * clients. `RpcClientError` wraps transport failures from the built-in HTTP,
 * socket, and worker protocols, while `RpcClientDefect` records protocol
 * problems such as empty HTTP responses, malformed response batches, failed
 * transport decoding, or unexpected connection failures.
 *
 * These errors are separate from a remote handler's typed error. Remote
 * failures that match an RPC's error schema are decoded from the RPC exit and
 * remain part of the procedure's domain error channel. Server defects and
 * schema mismatches are not normal remote errors: they surface as defects or
 * protocol failures, so handlers commonly inspect `RpcClientError.reason` to
 * decide whether a failure is retryable transport trouble or an incompatible
 * client/server schema or serialization boundary.
 *
 * @since 4.0.0
 */
export * as RpcClientError from "./RpcClientError.ts"

/**
 * Groups typed `Rpc` definitions into a protocol that can be shared by
 * clients, servers, tests, cluster entities, workflows, and other RPC
 * integrations.
 *
 * An `RpcGroup` keeps RPC definitions keyed by their tags while preserving the
 * payload, success, error, defect, middleware, and annotation metadata carried
 * by each `Rpc`. Build groups with `make`, extend them with `add`, combine them
 * with `merge`, remove calls with `omit`, and turn the final protocol into
 * handler contexts or layers with `toHandlers`, `toLayer`, or `toLayerHandler`.
 *
 * Common uses include defining a service surface once and deriving both client
 * and server implementations from it, splitting a large protocol into feature
 * groups that are merged later, prefixing generated or proxied RPC names, and
 * attaching metadata for higher-level runtimes. Composition order matters:
 * `middleware` and `annotateRpcs` update only the RPCs currently in the group,
 * duplicate tags from `add` or `merge` replace the existing definition, and
 * handlers are keyed by the tags after any prefixing. Schema requirements still
 * come from each RPC's payload, success, error, defect, and middleware schemas;
 * grouping preserves those requirements but does not provide the services
 * needed to encode, decode, or handle them.
 *
 * @since 4.0.0
 */
export * as RpcGroup from "./RpcGroup.ts"

/**
 * Defines the protocol message envelopes shared by unstable RPC clients,
 * servers, and transports.
 *
 * This module is used when implementing or testing RPC transports, codecs, and
 * protocol handlers. It separates decoded messages, which carry typed RPC tags,
 * payloads, headers, exits, and branded request identifiers, from encoded
 * messages, which are suitable for transport boundaries where request ids and
 * payloads have already been serialized.
 *
 * Request identifiers are the correlation point for requests, response chunks,
 * terminal exits, acknowledgements, and interrupts, so transports must preserve
 * them across the encoded string form and the decoded branded form. Streaming
 * responses can send one or more `Chunk` batches before a terminal `Exit`; use
 * `Ack` messages only for transports that require backpressure, treat `Eof` as
 * the end of client input, and reserve `Ping`/`Pong` for connection liveness
 * rather than RPC completion.
 *
 * @since 4.0.0
 */
export * as RpcMessage from "./RpcMessage.ts"

/**
 * The `RpcMiddleware` module defines middleware services that can wrap RPC
 * handler execution on the server and request execution in generated clients.
 *
 * Use middleware to attach cross-cutting behavior to individual RPCs or whole
 * `RpcGroup`s, such as authentication, authorization, request logging, tracing,
 * metrics, rate limiting, header propagation, or adding request-scoped services
 * to the handler context. A middleware service records the services it requires
 * and provides, the schema for errors it can fail with, and whether clients must
 * install a matching middleware via `layerClient`.
 *
 * Server middleware receives the target `rpc`, decoded `payload`, request
 * `headers`, `requestId`, and `Rpc.ServerClient`, then wraps the handler effect.
 * Its `provides` type removes services from the downstream handler requirement,
 * while `requires` adds the services needed by the middleware implementation.
 * Middleware errors must be declared with a `Schema` so they can be encoded as
 * RPC failures, and any schema encoding or decoding services remain part of the
 * generated RPC environments.
 *
 * Client middleware is installed with `layerClient`, captures the surrounding
 * layer context, and can inspect, rewrite, retry, or short-circuit outgoing
 * requests before calling `next`. Set `requiredForClient` when an RPC's typed
 * client must require that `ForClient` layer; otherwise a client implementation
 * is used only when one is present. `clientError` contributes only to the
 * client-side call error channel, while the middleware `error` schema is shared
 * with server failures.
 *
 * @since 4.0.0
 */
export * as RpcMiddleware from "./RpcMiddleware.ts"

/**
 * The `RpcSchema` module contains the RPC-specific schema markers and cause
 * annotations shared by the RPC declaration, client, and server layers. It is
 * used when an RPC response is a `Stream`, and when server-side interruption
 * logic needs to identify a client-initiated abort.
 *
 * Use {@link Stream} to mark an RPC success schema as a streamed response,
 * {@link isStreamSchema} to detect that marker, and the stored success and
 * error schemas to encode or decode stream chunks. Request payload schemas live
 * on the `Rpc` definition itself; this module only describes the streamed
 * response shape. For streaming RPCs, the success schema passed to
 * `RpcSchema.Stream` is the stream element schema, while the error schema is
 * the stream error schema. When the marker is installed by the `Rpc`
 * constructor's `stream` option, the immediate RPC exit succeeds with `void`,
 * the ordinary RPC error schema is set to `Schema.Never`, and the stream error
 * schema is used for stream failures.
 *
 * Streaming schemas are not general-purpose codecs for arbitrary stream values:
 * they are RPC metadata that lets the protocol distinguish one-shot successes
 * from streamed elements and keep stream errors on the chunk stream. Use
 * {@link ClientAbort} when annotating interruptions caused by a remote client
 * closing or cancelling a request.
 *
 * @since 4.0.0
 */
export * as RpcSchema from "./RpcSchema.ts"

/**
 * Serialization support for the unstable RPC protocol.
 *
 * This module provides the `RpcSerialization` service used by RPC clients and
 * servers to encode and decode transport-level `RpcMessage` envelopes. Use the
 * built-in JSON, newline-delimited JSON, JSON-RPC 2.0, and MessagePack
 * implementations when wiring HTTP, sockets, workers, or custom transports, or
 * provide a custom service when a transport needs a different content type,
 * frame format, or binary codec.
 *
 * Serialization runs after RPC schemas have encoded payloads, successes,
 * failures, and stream chunks into transport-safe values, and before schemas
 * decode those values on the other side. Choose a format that can represent the
 * schema-encoded data: JSON is easy to inspect but needs schema encodings for
 * arbitrary binary values, while MessagePack is more compact and carries binary
 * data more naturally.
 *
 * Transport framing is significant. `json` and `jsonRpc` expect a complete
 * payload for each decode call and are intended for transports such as HTTP
 * that already delimit message bodies. `ndjson`, `ndJsonRpc`, and `msgPack`
 * maintain parser state for chunked streams, so they can decode multiple
 * messages or incomplete fragments from sockets and other streaming transports.
 * Match the serialization layer to the transport boundary, otherwise messages
 * may be buffered, split, or parsed at the wrong frame.
 *
 * @since 4.0.0
 */
export * as RpcSerialization from "./RpcSerialization.ts"

/**
 * Server-side support for running RPCs defined in an `RpcGroup`.
 *
 * This module connects typed RPC handlers to an encoded or already-decoded
 * transport, decodes client requests, invokes the matching handler, and sends
 * exits, stream chunks, defects, interrupts, and client-end notifications back
 * through the active server protocol. Use it to expose an RPC group through
 * `layerHttp`, standalone HTTP effects, websocket or socket servers, stdio,
 * worker runners, or a custom `Protocol`; use `makeNoSerialization` when the
 * surrounding system already owns message serialization.
 *
 * The `Protocol` service is the transport boundary. It declares how encoded
 * client messages are received and how encoded responses are written, plus
 * whether the transport supports stream acknowledgements, transferable
 * objects, and span propagation. HTTP request/response serving is useful for
 * simple calls and response streaming, but it does not provide client
 * acknowledgements or span propagation; websocket, socket, stdio, and worker
 * protocols keep a live channel and can participate in the streaming
 * acknowledgement lifecycle.
 *
 * **Handler gotchas**
 *
 * - Server handlers are looked up from `Rpc.ToHandler`, while RPC middleware
 *   is looked up from `Rpc.Middleware` and wraps the handler with metadata
 *   containing the `Rpc.ServerClient`, request id, headers, and decoded payload
 * - Payloads are decoded on the server and exits, stream chunks, and request
 *   defects are encoded on the server using the RPC schemas and the handler's
 *   schema services; encode failures are reported as request defects and the
 *   in-flight request is interrupted
 * - Streaming RPCs send chunks before the final exit, and transports with
 *   acknowledgement support wait for client acknowledgements between chunks to
 *   provide back pressure
 * - Fatal handler defects are sent as protocol defects by default; set
 *   `disableFatalDefects` when defects should remain ordinary request exits
 *
 * @since 4.0.0
 */
export * as RpcServer from "./RpcServer.ts"

/**
 * Utilities for testing RPC groups without opening a network transport.
 *
 * This module connects a generated RPC client directly to an in-memory
 * `RpcServer` for the same group, using the group's handlers from the Effect
 * environment and the no-serialization message path. It is intended for tests
 * that need to exercise client calls, server handlers, middleware, request
 * routing, and streaming behavior without standing up HTTP, sockets, workers,
 * or a serializer.
 *
 * Because messages stay decoded in memory, this module is not a substitute for
 * transport or schema-encoding tests. Callers still need to provide the handler
 * layer, any client/server middleware services, and a `Scope`; the returned
 * client is scoped to that in-memory connection. The `flatten` option follows
 * `RpcClient.makeNoSerialization`, and acknowledgements are enabled to match
 * the normal bidirectional client/server protocol used by the test harness.
 *
 * @since 4.0.0
 */
export * as RpcTest from "./RpcTest.ts"

/**
 * Helpers for passing a schema-encoded bootstrap message to worker-backed RPC
 * protocols.
 *
 * Worker RPC protocols can send one initial message when each worker starts,
 * before ordinary RPC requests begin flowing. Use this module to build and
 * provide that message from the client side, and to decode it inside the
 * worker-side server. Common payloads include per-worker configuration,
 * credentials or session metadata, feature flags, preloaded data, or
 * transferable resources such as `ArrayBuffer` and `MessagePort` values.
 *
 * The initial message uses the supplied schema's JSON codec and is posted as a
 * worker message, so it is separate from the normal `RpcSerialization` used for
 * RPC request and response traffic. Values still need to be valid for the
 * worker transport's structured clone boundary. Transferable annotations can
 * collect objects for the `postMessage` transfer list, but transferring moves
 * ownership to the worker and may detach buffers from the sender.
 *
 * @since 4.0.0
 */
export * as RpcWorker from "./RpcWorker.ts"

/**
 * Internal helpers for constructing RPC protocol services whose receive loop is
 * installed separately from the operations that write to it.
 *
 * This module is used by the client and server `Protocol.make` constructors to
 * let transports expose a stable service immediately while buffering messages
 * until the protocol's `run` method has installed the active receiver. Buffered
 * writes keep the `Context` that was current at the time of the write, so
 * replaying early messages preserves fiber-local services such as tracing or
 * request metadata.
 *
 * The general `withRun` helper is for single receive-loop services, such as
 * server transports, while `withRunClient` specializes the same pattern for
 * client transports by tracking active client ids and keeping a separate buffer
 * per client. They are most useful when implementing custom RPC transports or
 * test protocols that need to send before the consumer fiber has started.
 *
 * These helpers intentionally work on `Omit<Service, "run">` and re-add `run`
 * so generated `Context.Service` static `make` members can preserve their
 * exact service shape. When using them from generated or type-helper-heavy
 * protocol code, keep the `run` signature aligned with the target service:
 * the server helper has one shared writer, but the client helper requires a
 * `clientId` because responses and buffered messages are routed per client.
 *
 * @since 4.0.0
 */
export * as Utils from "./Utils.ts"
