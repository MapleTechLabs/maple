/**
 * Typed error definitions for the unstable worker APIs.
 *
 * `WorkerError` is the shared error channel for `WorkerPlatform` and
 * `WorkerRunnerPlatform` implementations. The nested reason identifies where a
 * platform failure happened: spawning or setting up a worker, sending through
 * `postMessage`, receiving worker events, or handling a runtime-specific
 * failure that does not fit the other categories. This is useful when building
 * worker-backed RPC clients and servers, implementing a platform adapter, or
 * recovering differently from startup, transport, and worker-exit failures.
 *
 * Worker transports cross browser, Node, Bun, and child-process runtimes, so the
 * original cause is best treated as diagnostic data. Spawn failures can mean the
 * runner is not actually executing inside a worker context, send failures often
 * come from structured-clone or transfer-list problems, and receive failures
 * may be reported as `messageerror`, `error`, or exit events depending on the
 * runtime. The `WorkerErrorReason` schema supports encoding and decoding the
 * tagged reasons, but message payloads still need to be valid for the selected
 * worker protocol and runtime.
 *
 * @since 4.0.0
 */
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/workers/WorkerError" as const

/**
 * Type-level identifier used to brand `WorkerError` values.
 *
 * @category Symbols
 * @since 4.0.0
 */
export type TypeId = typeof TypeId

/**
 * Returns `true` when a value is a `WorkerError`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isWorkerError = (u: unknown): u is WorkerError => hasProperty(u, TypeId)

/**
 * Worker error reason for failures while spawning or setting up a worker.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerSpawnError extends Schema.ErrorClass<WorkerSpawnError>(
  "effect/workers/WorkerError/WorkerSpawnError"
)({
  _tag: Schema.tag("WorkerSpawnError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Worker error reason for failures while sending a message to a worker.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerSendError extends Schema.ErrorClass<WorkerSendError>(
  "effect/workers/WorkerError/WorkerSendError"
)({
  _tag: Schema.tag("WorkerSendError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Worker error reason for failures while receiving or handling a message from a
 * worker.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerReceiveError extends Schema.ErrorClass<WorkerReceiveError>(
  "effect/workers/WorkerError/WorkerReceiveError"
)({
  _tag: Schema.tag("WorkerReceiveError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Worker error reason for an unclassified worker failure.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerUnknownError extends Schema.ErrorClass<WorkerUnknownError>(
  "effect/workers/WorkerError/WorkerUnknownError"
)({
  _tag: Schema.tag("WorkerUnknownError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Union of the specific failure reasons that can be wrapped by a `WorkerError`.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkerErrorReason =
  | WorkerSpawnError
  | WorkerSendError
  | WorkerReceiveError
  | WorkerUnknownError

/**
 * Schema for decoding and encoding all supported worker error reason variants.
 *
 * @category models
 * @since 4.0.0
 */
export const WorkerErrorReason: Schema.Union<[
  typeof WorkerSpawnError,
  typeof WorkerSendError,
  typeof WorkerReceiveError,
  typeof WorkerUnknownError
]> = Schema.Union([
  WorkerSpawnError,
  WorkerSendError,
  WorkerReceiveError,
  WorkerUnknownError
])

/**
 * Error raised by worker APIs, wrapping a specific `WorkerErrorReason` and
 * exposing its message and cause.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerError extends Schema.ErrorClass<WorkerError>(TypeId)({
  _tag: Schema.tag("WorkerError"),
  reason: WorkerErrorReason
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: WorkerErrorReason
  }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }
  /**
   * Marks this value as a worker error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId]: TypeId = TypeId

  override get message(): string {
    return this.reason.message
  }
}
