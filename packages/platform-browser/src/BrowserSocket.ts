/**
 * Browser WebSocket layers for Effect sockets.
 *
 * This module provides the browser entry point for `Socket.Socket` values
 * backed by the platform `WebSocket` implementation. Use `layerWebSocket` when
 * client-side Effect programs, browser tests, RPC transports, or realtime UI
 * features need a bidirectional socket connected to a WebSocket URL, and use
 * `layerWebSocketConstructor` when lower-level socket APIs need access to the
 * browser constructor service.
 *
 * Browser WebSocket rules still apply. Connections are created through
 * `globalThis.WebSocket`, so URL schemes, subprotocol negotiation, mixed-content
 * blocking, cookies, authentication, CORS-like origin checks, and extension
 * negotiation are controlled by the browser and server rather than by Effect.
 * Close events are translated into socket errors unless the provided
 * `closeCodeIsError` predicate classifies the close code as clean, which is
 * useful for protocols that use application-specific close codes.
 *
 * Messages are delivered as strings or binary `Uint8Array` values; browser
 * `Blob` messages are read into bytes before they reach the socket handler.
 * Outgoing data should already be serialized to a string or bytes, and protocol
 * frames that represent an intentional close should be sent as `CloseEvent`
 * values so the underlying `WebSocket.close` code and reason are preserved.
 *
 * @since 4.0.0
 */
import * as Layer from "effect/Layer"
import * as Socket from "effect/unstable/socket/Socket"

/**
 * Creates a `Socket` layer connected to the given URL using the browser `WebSocket` constructor.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket = (url: string, options?: {
  readonly closeCodeIsError?: (code: number) => boolean
}): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, Socket.makeWebSocket(url, options)).pipe(
    Layer.provide(layerWebSocketConstructor)
  )

/**
 * Layer that provides a `WebSocketConstructor` service backed by `globalThis.WebSocket`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  Socket.layerWebSocketConstructorGlobal
