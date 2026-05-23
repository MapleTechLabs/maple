/**
 * Server-side worker runner primitives shared by the browser, Node, and Bun
 * platform packages.
 *
 * A `WorkerRunnerPlatform` is installed in code that is already running inside
 * a worker-like runtime. Starting it yields a `WorkerRunner`, which listens for
 * parent or client requests, identifies each connection with a numeric port id,
 * and sends responses back through the same transport. The main Effect use case
 * is `RpcServer.layerProtocolWorkerRunner`, but platform adapters can also use
 * these types to expose lower-level request handlers for dedicated workers,
 * shared workers, worker threads, or child-process channels.
 *
 * The wire protocol is intentionally small: inbound messages are
 * `PlatformMessage` values where `[0, payload]` is a request and `[1]` closes a
 * port. Higher-level protocols are responsible for encoding request and
 * response payloads before they cross the worker boundary. Values must still be
 * accepted by the selected runtime's message mechanism, so structured-clone
 * support, transfer lists, `messageerror` events, and single-port runtimes such
 * as Node or Bun should be considered when choosing payload schemas and
 * resource lifetimes. Handler effects run on the runtime captured by `run`, so
 * services required by the handler must be provided to the running effect.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import type * as Effect from "../../Effect.ts"
import type * as Queue from "../../Queue.ts"
import type { WorkerError } from "./WorkerError.ts"

/**
 * Platform-neutral worker runner that receives inbound messages by port ID,
 * sends outbound messages, and optionally exposes disconnect notifications.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkerRunner<O = unknown, I = unknown> {
  readonly run: <A, E, R>(
    handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void
  ) => Effect.Effect<void, WorkerError, R>
  readonly send: (
    portId: number,
    message: O,
    transfers?: ReadonlyArray<unknown>
  ) => Effect.Effect<void>
  readonly sendUnsafe: (
    portId: number,
    message: O,
    transfers?: ReadonlyArray<unknown>
  ) => void
  readonly disconnects?: Queue.Dequeue<number> | undefined
}

/**
 * Wire protocol message used by worker platforms: a request carrying input or a
 * close signal.
 *
 * @category models
 * @since 4.0.0
 */
export type PlatformMessage<I> = readonly [request: 0, I] | readonly [close: 1]

/**
 * Context service that starts a platform-specific `WorkerRunner`.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerRunnerPlatform extends Context.Service<WorkerRunnerPlatform, {
  readonly start: <O = unknown, I = unknown>() => Effect.Effect<WorkerRunner<O, I>, WorkerError>
}>()("effect/workers/WorkerRunner/WorkerRunnerPlatform") {}
