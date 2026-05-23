/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Effect-based socket abstractions for bidirectional connections that exchange
 * text frames, binary frames, and close events.
 *
 * This module defines the `Socket` service, constructors for WebSocket-backed
 * and transform-stream-backed sockets, typed socket errors, and adapters that
 * expose a socket as a bidirectional `Channel`. It is intended for WebSocket
 * clients, HTTP server upgrades, protocol clients and servers, and tests or
 * adapters that need a scoped duplex transport inside Effect programs.
 *
 * Incoming data can be consumed as raw frames, binary bytes, or strings.
 * `runRaw` preserves whether the transport delivered a string or `Uint8Array`,
 * while `run` encodes string frames as UTF-8 bytes and `runString` decodes
 * binary frames with `TextDecoder`. Use the raw or mapping APIs when preserving
 * frame boundaries, binary payloads, or text encodings matters.
 *
 * Writers are scoped to an active run and are gated until the underlying
 * connection is open; use `onOpen` when startup writes must wait for that
 * point. Outgoing strings and bytes are sent as data frames, while `CloseEvent`
 * values request a close. Close events are modeled as `SocketCloseError` by
 * default, and `closeCodeIsError` controls which close codes should fail a run
 * versus complete cleanly.
 *
 * @since 4.0.0
 */
export * as Socket from "./Socket.ts"

/**
 * Effect service model for servers that accept socket connections and hand each
 * accepted connection to an Effect handler as a `Socket.Socket`.
 *
 * This module contains the shared, platform-independent contract for socket
 * servers: a bound `address`, a long-running `run` accept loop, the TCP and
 * Unix socket address models, and the server-level errors reported while
 * opening or running a server. Concrete transports, such as Node TCP servers or
 * WebSocket servers, provide this service through platform-specific layers.
 *
 * `SocketServer` is commonly used as the server transport for RPC protocols,
 * cluster runners, developer tools, and tests that need an ephemeral TCP port or
 * Unix-domain socket. A server address may differ from the requested listen
 * options after binding, for example when listening on port `0`, so consumers
 * should read the provided `address` from the service.
 *
 * The `run` effect represents the server accept loop and is expected to remain
 * alive until interrupted or until the providing scope is closed. Protocol
 * framing is intentionally outside this module: handlers receive a generic
 * `Socket.Socket`, so callers are responsible for choosing byte, string, raw
 * frame, or higher-level protocol adapters and for treating connection-level
 * failures separately from `SocketServerError` values.
 *
 * @since 4.0.0
 */
export * as SocketServer from "./SocketServer.ts"
