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
import * as Effect from "../../Effect.ts"
import * as Queue from "../../Queue.ts"
import * as Schema from "../../Schema.ts"
import * as Stream from "../../Stream.ts"
import * as Ndjson from "../encoding/Ndjson.ts"
import * as Socket from "../socket/Socket.ts"
import * as SocketServer from "../socket/SocketServer.ts"
import * as DevToolsSchema from "./DevToolsSchema.ts"

const RequestSchema = Schema.toCodecJson(DevToolsSchema.Request)
const ResponseSchema = Schema.toCodecJson(DevToolsSchema.Response)

/**
 * Handle for a connected devtools client.
 *
 * **Details**
 *
 * It exposes a queue of non-ping requests received from the socket and a
 * `send` function for non-pong responses.
 *
 * @category models
 * @since 4.0.0
 */
export interface Client {
  readonly queue: Queue.Dequeue<DevToolsSchema.Request.WithoutPing>
  readonly send: (_: DevToolsSchema.Response.WithoutPong) => Effect.Effect<void>
}

/**
 * Runs the devtools socket server.
 *
 * **Details**
 *
 * Each connection is decoded as NDJSON devtools protocol messages, `Ping`
 * requests are answered with `Pong`, and all other requests are delivered
 * through the `Client` passed to the handler.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: <_, E, R>(
  handle: (client: Client) => Effect.Effect<_, E, R>
) => Effect.Effect<
  never,
  SocketServer.SocketServerError,
  R | SocketServer.SocketServer
> = Effect.fnUntraced(function*<R, E, _>(
  handle: (client: Client) => Effect.Effect<_, E, R>
) {
  const server = yield* SocketServer.SocketServer

  return yield* server.run(Effect.fnUntraced(function*(socket) {
    const responses = yield* Queue.unbounded<DevToolsSchema.Response>()
    const requests = yield* Queue.unbounded<DevToolsSchema.Request.WithoutPing>()

    const client: Client = {
      queue: requests,
      send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid)
    }

    yield* Stream.fromQueue(responses).pipe(
      Stream.pipeThroughChannel(
        Ndjson.duplexSchemaString(Socket.toChannelString(socket), {
          inputSchema: ResponseSchema,
          outputSchema: RequestSchema
        })
      ),
      Stream.runForEach((request) =>
        request._tag === "Ping"
          ? Queue.offer(responses, { _tag: "Pong" })
          : Queue.offer(requests, request)
      ),
      Effect.ensuring(
        Queue.shutdown(responses).pipe(
          Effect.andThen(Queue.shutdown(requests))
        )
      ),
      Effect.forkChild
    )

    return yield* handle(client)
  }))
})
