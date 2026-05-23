/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for wiring an Effect application to the Effect devtools runtime
 * tracer.
 *
 * This module is the high-level entry point for installing the devtools tracer
 * as a `Layer`. Use it when an application should stream spans, span events,
 * span completions, and metrics snapshots to a devtools process for local
 * inspection. The default `layer` and `layerWebSocket` helpers connect over a
 * WebSocket to `ws://localhost:34437`, while `layerSocket` lets integrations
 * provide their own `Socket` transport.
 *
 * These layers install tracing for the scoped runtime they are provided to;
 * they do not start a devtools server, and a compatible devtools endpoint must
 * be reachable separately. Because this API lives under `unstable`, its
 * protocol and surface may change between releases.
 *
 * @since 4.0.0
 */
export * as DevTools from "./DevTools.ts"

/**
 * Provides the low-level client used by the unstable devtools integration to
 * exchange telemetry with an Effect devtools server over the current `Socket`.
 *
 * The client speaks the devtools NDJSON protocol, publishes span starts, span
 * events, span completions, and metric snapshots, and exposes layers for
 * installing a tracer that mirrors the current tracer while forwarding data to
 * devtools. Most applications should use the higher-level devtools layers
 * instead of constructing this service directly. When using this module
 * directly, provide a live `Socket`, keep the layer scoped so the background
 * ping and stream fibers are finalized, and prefer `layerTracer` when the goal
 * is to observe an application's Effect traces.
 *
 * @since 4.0.0
 */
export * as DevToolsClient from "./DevToolsClient.ts"

/**
 * Schemas and TypeScript types for the Effect devtools protocol.
 *
 * This module defines the wire format used by devtools clients and servers to
 * exchange telemetry, including spans, span events, metric snapshots, fiber
 * dumps, heartbeat messages, and request/response payloads. Use these schemas
 * when encoding or decoding messages at the devtools boundary, validating
 * custom transports, or building integrations that need to inspect the same
 * protocol data as the built-in devtools implementation.
 *
 * The exported values describe serialized protocol payloads rather than the
 * full in-memory runtime data structures. Some fields intentionally normalize
 * runtime values for transport, for example ended span exits are encoded with
 * successful values erased via `Exit.asVoid`, timestamps are represented as
 * `bigint`s, and arbitrary attributes are accepted as unknown schema values.
 * The module lives under `unstable`, so consumers should treat the protocol
 * shape as experimental.
 *
 * @since 4.0.0
 */
export * as DevToolsSchema from "./DevToolsSchema.ts"

/**
 * Server-side helpers for exposing the Effect devtools protocol over a socket.
 *
 * This module is used by runtime integrations that want to accept devtools
 * clients, decode newline-delimited JSON protocol messages, and hand each
 * connected client to application-specific handling logic. It is most useful
 * for building a devtools endpoint that can inspect running fibers, spans, and
 * other telemetry described by `DevToolsSchema`.
 *
 * The server automatically responds to protocol `Ping` requests with `Pong`
 * responses. All other requests are delivered through the connected `Client`
 * queue, while responses should be written with `Client.send`. The queue is
 * shut down when the socket processing fiber terminates, so handlers should
 * treat it as connection-scoped state rather than a long-lived global channel.
 *
 * @since 4.0.0
 */
export * as DevToolsServer from "./DevToolsServer.ts"
