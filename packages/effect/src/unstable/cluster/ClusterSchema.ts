/**
 * The `ClusterSchema` module defines the schema annotations used by Effect
 * Cluster protocols. These annotations attach cluster-specific behavior to
 * RPCs and entities without changing the request or response schemas
 * themselves.
 *
 * **Common tasks**
 *
 * - Mark requests as persisted so mailbox storage can replay them after
 *   interruption or restart
 * - Run server-side handling inside a storage transaction when durable state
 *   and SQL updates must commit together
 * - Control whether client sending, server handling, or both are treated as
 *   uninterruptible
 * - Route entity ids into shard groups
 * - Disable client tracing for internal protocols such as cron dispatch
 * - Derive per-request annotations from the encoded request with {@link Dynamic}
 *
 * **Protocol notes**
 *
 * Cluster transports serialize the RPC payloads, not arbitrary runtime
 * annotation values. Prefer static, deterministic annotations, and use
 * {@link Dynamic} when a persisted or transactional decision depends on the
 * request value that is already part of the protocol. Persisted requests require
 * message storage support, and shard group selection must remain stable for a
 * given entity id so routing is consistent across cluster members.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import { constFalse, constTrue, identity } from "../../Function.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import type { EntityId } from "./EntityId.ts"
import type { Request } from "./Envelope.ts"

/**
 * Annotation that marks whether a cluster request should be persisted in mailbox
 * storage.
 *
 * **Details**
 *
 * The default value is `false`.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Persisted = Context.Reference<boolean>("effect/cluster/ClusterSchema/Persisted", {
  defaultValue: constFalse
})

/**
 * Whether to wrap the request with a storage transaction, so sql queries are
 * committed atomically.
 *
 * @category annotations
 * @since 4.0.0
 */
export const WithTransaction = Context.Reference<boolean>(
  "effect/cluster/ClusterSchema/WithTransaction",
  { defaultValue: constFalse }
)

/**
 * Annotation that controls whether a cluster request is treated as
 * uninterruptible.
 *
 * **Details**
 *
 * Use `true` for both client and server handling, `"client"` for client-side
 * handling only, `"server"` for server-side handling only, or `false` to allow
 * interruption.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Uninterruptible = Context.Reference<boolean | "client" | "server">(
  "effect/cluster/ClusterSchema/Uninterruptible",
  { defaultValue: constFalse }
)

/**
 * Returns whether the `Uninterruptible` annotation applies to server-side
 * request handling for the provided context.
 *
 * @category annotations
 * @since 4.0.0
 */
export const isUninterruptibleForServer = (context: Context.Context<never>): boolean => {
  const value = Context.get(context, Uninterruptible)
  return value === true || value === "server"
}

/**
 * Returns whether the `Uninterruptible` annotation applies to client-side
 * request handling for the provided context.
 *
 * @category annotations
 * @since 4.0.0
 */
export const isUninterruptibleForClient = (context: Context.Context<never>): boolean => {
  const value = Context.get(context, Uninterruptible)
  return value === true || value === "client"
}

/**
 * Annotation that selects the shard group for an entity id.
 *
 * **Details**
 *
 * By default, every entity id is assigned to the `"default"` shard group.
 *
 * @category annotations
 * @since 4.0.0
 */
export const ShardGroup = Context.Reference<(entityId: EntityId) => string>(
  "effect/cluster/ClusterSchema/ShardGroup",
  { defaultValue: () => (_) => "default" }
)

/**
 * Annotation that controls whether client-side cluster request tracing is
 * enabled.
 *
 * **Details**
 *
 * The default value is `true`.
 *
 * @category annotations
 * @since 4.0.0
 */
export const ClientTracingEnabled = Context.Reference<boolean>("effect/cluster/ClusterSchema/ClientTracingEnabled", {
  defaultValue: constTrue
})

/**
 * Dynamically transform the request annotations based on the request.
 * This only applies to the requests handled by the Entity, not the client.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Dynamic = Context.Reference<
  (annotations: Context.Context<never>, request: Request<Rpc.AnyWithProps>) => Context.Context<never>
>(
  "effect/cluster/ClusterSchema/Dynamic",
  { defaultValue: () => identity }
)
