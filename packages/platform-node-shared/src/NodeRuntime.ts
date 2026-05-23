/**
 * Shared runtime helpers for running Effect programs as Node-compatible
 * process entry points.
 *
 * This module provides the common `runMain` implementation used by
 * Node-compatible platform packages. It is intended for CLIs, scripts,
 * workers, servers, and other process-oriented programs that should run an
 * Effect as their main fiber while still following Node process conventions.
 *
 * The runner installs `SIGINT` and `SIGTERM` handlers for the lifetime of the
 * main fiber, translating those process signals into fiber interruption so
 * Effect finalizers and the configured teardown can run. When the fiber exits,
 * the signal listeners are removed and teardown determines the exit code. Clean
 * success lets the Node event loop drain naturally instead of forcing
 * `process.exit(0)`, while signal-triggered or non-zero exits call
 * `process.exit` after teardown, so long-running resources should be modeled
 * in the Effect scope and finalized explicitly.
 *
 * @since 4.0.0
 */
import type { Effect } from "effect/Effect"
import * as Runtime from "effect/Runtime"

/**
 * Runs an Effect as the Node process main program, interrupting the fiber on
 * `SIGINT` or `SIGTERM` and invoking the configured teardown to determine the
 * process exit code.
 *
 * @category running
 * @since 4.0.0
 */
export const runMain: {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Runtime.Teardown | undefined
    }
  ): <E, A>(effect: Effect<A, E>) => void
  <E, A>(
    effect: Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Runtime.Teardown | undefined
    }
  ): void
} = Runtime.makeRunMain(({
  fiber,
  teardown
}) => {
  let receivedSignal = false

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigint)
    teardown(exit, (code) => {
      if (receivedSignal || code !== 0) {
        process.exit(code)
      }
    })
  })

  function onSigint() {
    receivedSignal = true
    fiber.interruptUnsafe(fiber.id)
  }

  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigint)
})
