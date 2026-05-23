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
import * as Layer from "../../Layer.ts"
import * as Socket from "../socket/Socket.ts"
import * as DevToolsClient from "./DevToolsClient.ts"

/**
 * Layer that installs the devtools tracer using an existing `Socket`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSocket: Layer.Layer<never, never, Socket.Socket> = DevToolsClient.layerTracer

/**
 * Layer that installs the devtools tracer over a WebSocket connection to the
 * specified URL, defaulting to `ws://localhost:34437`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket = (
  url = "ws://localhost:34437"
): Layer.Layer<never, never, Socket.WebSocketConstructor> =>
  DevToolsClient.layerTracer.pipe(
    Layer.provide(Socket.layerWebSocket(url))
  )

/**
 * Layer that installs the devtools tracer over a WebSocket connection using the
 * global WebSocket constructor, defaulting to `ws://localhost:34437`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (url = "ws://localhost:34437"): Layer.Layer<never> =>
  layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  )
