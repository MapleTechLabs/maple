/**
 * Bun entry-point helpers for running Effect programs.
 *
 * This module exposes `runMain`, the Bun runtime launcher used at the edge of
 * CLIs, scripts, servers, and worker processes. It runs an already
 * self-contained Effect as the process main program, using the shared
 * Node-compatible runtime implementation for error reporting, teardown, and
 * `process` signal handling available in Bun.
 *
 * `BunRuntime` does not provide application services by itself. Provide any
 * required layers, such as `BunServices.layer` or narrower service-specific
 * layers, before passing the effect to `runMain`. On `SIGINT` or `SIGTERM`,
 * the main fiber is interrupted so scoped resources and finalizers can shut
 * down; keep long-running servers, workers, and subscriptions attached to that
 * scope and avoid finalizers that never complete, otherwise process shutdown
 * can be delayed.
 *
 * @since 4.0.0
 */
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import type { Effect } from "effect/Effect"
import type { Teardown } from "effect/Runtime"

/**
 * Helps you run a main effect with built-in error handling, logging, and signal management.
 *
 * **When to use**
 *
 * Use this function to run an Effect as your application's main program,
 * especially when you need structured error handling, log management,
 * interrupt support, or advanced teardown capabilities.
 *
 * **Details**
 *
 * This function launches an Effect as the main entry point, setting exit codes
 * based on success or failure, handling interrupts (e.g., Ctrl+C), and optionally
 * logging errors. By default, it logs errors and uses a "pretty" format, but both
 * behaviors can be turned off. You can also provide custom teardown logic to
 * finalize resources or produce different exit codes.
 *
 * An optional object that can include:
 * - `disableErrorReporting`: Turn off automatic error logging.
 * - `disablePrettyLogger`: Avoid adding the pretty logger.
 * - `teardown`: Provide custom finalization logic.
 *
 * @category running
 * @since 4.0.0
 */
export const runMain: {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): <E, A>(effect: Effect<A, E>) => void
  <E, A>(
    effect: Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): void
} = NodeRuntime.runMain
