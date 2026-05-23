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
import * as Effect from "../../Effect.ts"
import type * as Scope from "../../Scope.ts"
import type * as Rpc from "./Rpc.ts"
import * as RpcClient from "./RpcClient.ts"
import type * as RpcGroup from "./RpcGroup.ts"
import * as RpcServer from "./RpcServer.ts"

/**
 * Creates an in-memory RPC client for a group, backed by the group's handlers
 * from the environment and using the no-serialization test transport.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeClient: <Rpcs extends Rpc.Any, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    readonly flatten?: Flatten | undefined
  }
) => Effect.Effect<
  Flatten extends true ? RpcClient.RpcClient.Flat<Rpcs> : RpcClient.RpcClient<Rpcs>,
  never,
  Scope.Scope | Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs> | Rpc.MiddlewareClient<Rpcs>
> = Effect.fnUntraced(function*<Rpcs extends Rpc.Any, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    readonly flatten?: Flatten | undefined
  }
) {
  // oxlint-disable-next-line prefer-const
  let client!: Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never, Flatten>>>
  const server = yield* RpcServer.makeNoSerialization(group, {
    onFromServer(response) {
      return client.write(response)
    }
  })
  client = yield* RpcClient.makeNoSerialization(group, {
    supportsAck: true,
    flatten: options?.flatten,
    onFromClient({ message }) {
      return server.write(0, message)
    }
  })
  return client.client
})
