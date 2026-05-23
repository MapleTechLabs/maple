/**
 * The `Stdio` module defines the service interface used by Effect programs to
 * interact with process standard I/O. It models command-line arguments,
 * standard output, standard error, and standard input as Effects, Sinks, and
 * Streams so programs can depend on console I/O through `Context` instead of
 * directly coupling to a specific runtime.
 *
 * Use this module when building command-line programs, tests, or platform
 * integrations that need to read bytes from stdin, write text or bytes to
 * stdout/stderr, or provide deterministic replacements for those capabilities.
 * The `layerTest` helper is useful for tests because it supplies inert defaults
 * and lets individual fields be overridden.
 *
 * Standard I/O operations are platform capabilities and may fail with
 * `PlatformError`; handle those failures in the Effect error channel rather than
 * assuming writes or reads are infallible.
 *
 * @since 4.0.0
 */
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Layer from "./Layer.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Sink from "./Sink.ts"
import * as Stream from "./Stream.ts"

/**
 * String literal type used as the unique brand for the `Stdio` service.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/Stdio"

/**
 * Runtime identifier stored on `Stdio` service implementations.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/Stdio"

/**
 * Service interface for process standard I/O.
 *
 * **Details**
 *
 * The service provides command-line arguments, sinks for standard output and
 * standard error, and a stream of standard input bytes. I/O operations can fail
 * with `PlatformError`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Stdio {
  readonly [TypeId]: TypeId
  readonly args: Effect.Effect<ReadonlyArray<string>>
  stdout(options?: {
    readonly endOnDone?: boolean | undefined
  }): Sink.Sink<void, string | Uint8Array, never, PlatformError>
  stderr(options?: {
    readonly endOnDone?: boolean | undefined
  }): Sink.Sink<void, string | Uint8Array, never, PlatformError>
  readonly stdin: Stream.Stream<Uint8Array, PlatformError>
}
/**
 * Context service tag for the `Stdio` service.
 *
 * @category services
 * @since 4.0.0
 */
export const Stdio: Context.Service<Stdio, Stdio> = Context.Service<Stdio>(TypeId)

/**
 * Creates a `Stdio` service implementation from the provided fields and
 * attaches the `Stdio` type identifier.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: Omit<Stdio, TypeId>): Stdio => ({
  [TypeId]: TypeId,
  ...options
})

/**
 * Creates a test layer for `Stdio`.
 *
 * **Details**
 *
 * Any provided fields override defaults. By default, arguments are empty,
 * standard output and error are draining sinks, and standard input is an empty
 * stream.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTest = (impl: Partial<Stdio>): Layer.Layer<Stdio> =>
  Layer.succeed(
    Stdio,
    make({
      args: Effect.succeed([]),
      stdout: () => Sink.drain,
      stderr: () => Sink.drain,
      stdin: Stream.empty,
      ...impl
    })
  )
