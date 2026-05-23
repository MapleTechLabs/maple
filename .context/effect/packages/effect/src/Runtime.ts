/**
 * This module provides utilities for running Effect programs and managing their execution lifecycle.
 *
 * The Runtime module contains functions for creating main program runners that handle process
 * teardown, error reporting, and exit code management. These utilities are particularly useful
 * for creating CLI applications and server processes that need to manage their lifecycle properly.
 *
 * **Example** (Creating a main runner)
 *
 * ```ts
 * import { Effect, Fiber, Runtime } from "effect"
 *
 * // Create a main runner for Node.js
 * const runMain = Runtime.makeRunMain((options) => {
 *   process.on("SIGINT", () => Effect.runFork(Fiber.interrupt(options.fiber)))
 *   process.on("SIGTERM", () => Effect.runFork(Fiber.interrupt(options.fiber)))
 *
 *   options.fiber.addObserver((exit) => {
 *     options.teardown(exit, (code) => process.exit(code))
 *   })
 * })
 *
 * // Use the runner
 * const program = Effect.log("Hello, World!")
 * runMain(program)
 * ```
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { constVoid, dual } from "effect/Function"
import type * as Fiber from "./Fiber.ts"

/**
 * Represents a teardown function that handles program completion and determines the exit code.
 *
 * **Details**
 *
 * A teardown function is called when an Effect program completes, either successfully or with a failure. It determines the appropriate exit code and can perform cleanup before invoking the supplied `onExit` callback.
 *
 * **Example** (Customizing teardown behavior)
 *
 * ```ts
 * import { Effect, Exit, Runtime } from "effect"
 *
 * // Custom teardown that logs completion status
 * const customTeardown: Runtime.Teardown = (exit, onExit) => {
 *   if (Exit.isSuccess(exit)) {
 *     console.log("Program completed successfully with value:", exit.value)
 *     onExit(0)
 *   } else {
 *     console.log("Program failed with cause:", exit.cause)
 *     onExit(1)
 *   }
 * }
 *
 * // Use with makeRunMain
 * const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
 *   fiber.addObserver((exit) => {
 *     teardown(exit, (code) => {
 *       console.log(`Exiting with code: ${code}`)
 *     })
 *   })
 * })
 *
 * const program = Effect.succeed("Hello, World!")
 * runMain(program, { teardown: customTeardown })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Teardown {
  <E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void): void
}

/**
 * The default teardown function that determines exit codes from an Effect exit.
 *
 * **Details**
 *
 * This teardown function follows standard Unix conventions: exit code `0` for successful completion, exit code `1` for failures unless the squashed error has a `Runtime.errorExitCode` marker, and exit code `130` for interruption-only failures.
 *
 * **Example** (Using default teardown)
 *
 * ```ts
 * import { Exit, Runtime } from "effect"
 *
 * const logExitCode = (exit: Exit.Exit<any, any>) => {
 *   Runtime.defaultTeardown(exit, (code) => {
 *     console.log(`Exit code: ${code}`)
 *   })
 * }
 *
 * logExitCode(Exit.succeed(42))
 * // Output: Exit code: 0
 *
 * logExitCode(Exit.fail("error"))
 * // Output: Exit code: 1
 *
 * logExitCode(Exit.interrupt(123))
 * // Output: Exit code: 130
 * ```
 *
 * @category Teardown
 * @since 4.0.0
 */
export const defaultTeardown: Teardown = <E, A>(
  exit: Exit.Exit<E, A>,
  onExit: (code: number) => void
) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  return onExit(getErrorExitCode(Cause.squash(exit.cause)))
}

/**
 * Creates a platform-specific main program runner that handles Effect execution lifecycle.
 *
 * **Details**
 *
 * The runner executes Effect programs as main entry points. The provided function receives a forked fiber and a teardown callback so it can install platform-specific signal handling, fiber observers, and final exit behavior.
 *
 * **Example** (Creating platform runners)
 *
 * ```ts
 * import { Effect, Fiber, Runtime } from "effect"
 *
 * // Create a simple runner for a hypothetical platform
 * const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
 *   // Set up signal handling
 *   const handleSignal = () => {
 *     Effect.runSync(Fiber.interrupt(fiber))
 *   }
 *
 *   // Add signal listeners (platform-specific)
 *   // process.on('SIGINT', handleSignal)
 *   // process.on('SIGTERM', handleSignal)
 *
 *   // Handle fiber completion
 *   fiber.addObserver((exit) => {
 *     teardown(exit, (code) => {
 *       console.log(`Program finished with exit code: ${code}`)
 *       // process.exit(code)
 *     })
 *   })
 * })
 *
 * // Use the runner
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Starting program")
 *   yield* Effect.sleep(1000)
 *   yield* Effect.log("Program completed")
 *   return "success"
 * })
 *
 * // Run with default options
 * runMain(program)
 *
 * // Run with custom teardown
 * runMain(program, {
 *   teardown: (exit, onExit) => {
 *     console.log("Custom teardown logic")
 *     Runtime.defaultTeardown(exit, onExit)
 *   }
 * })
 * ```
 *
 * @category running
 * @since 4.0.0
 */
export const makeRunMain = (
  f: <E, A>(
    options: {
      readonly fiber: Fiber.Fiber<A, E>
      readonly teardown: Teardown
    }
  ) => void
): {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): <E, A>(effect: Effect.Effect<A, E>) => void
  <E, A>(
    effect: Effect.Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): void
} =>
  dual((args) => Effect.isEffect(args[0]), (effect: Effect.Effect<any, any>, options?: {
    readonly disableErrorReporting?: boolean | undefined
    readonly teardown?: Teardown | undefined
  }) => {
    const fiber = options?.disableErrorReporting === true
      ? Effect.runFork(effect)
      : Effect.runFork(
        Effect.tapCause(effect, (cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void
          const isReported = getErrorReported(Cause.squash(cause))
          return isReported ? Effect.logError(cause) : Effect.void
        })
      )
    try {
      const keepAlive = globalThis.setInterval(constVoid, 2_147_483_647)
      fiber.addObserver(() => {
        clearInterval(keepAlive)
      })
    } catch {}
    const teardown = options?.teardown ?? defaultTeardown
    return f({ fiber, teardown })
  })

declare global {
  interface Error {
    readonly [errorExitCode]?: number
    readonly [errorReported]?: boolean
  }
}

/**
 * Type-level key for the `Runtime.errorExitCode` property that can be attached
 * to an `Error` to customize the process exit code used by `runMain`.
 *
 * @category Exit code management
 * @since 4.0.0
 */
export type errorExitCode = "~effect/Runtime/errorExitCode"

/**
 * Allows associating an exit code with an error for determining the process
 * exit code on failure.
 *
 * **Example** (Setting a process exit code)
 *
 * ```ts
 * import { Data, Effect, Runtime } from "effect"
 * import { NodeRuntime } from "@effect/platform-node"
 *
 * class MyError extends Data.TaggedError("MyError") {
 *   readonly [Runtime.errorExitCode] = 42
 * }
 *
 * // If the program fails with MyError, the process will exit with code 42
 * NodeRuntime.runMain(Effect.fail(new MyError()))
 * ```
 *
 * @category Exit code management
 * @since 4.0.0
 */
export const errorExitCode: errorExitCode = "~effect/Runtime/errorExitCode"

/**
 * Reads the runtime exit-code marker from an unknown error value.
 *
 * **Details**
 *
 * Returns the numeric `[Runtime.errorExitCode]` property when it is present on
 * an object. Otherwise returns `1`, the default failure exit code used by
 * `defaultTeardown`.
 *
 * @category Exit code management
 * @since 4.0.0
 */
export const getErrorExitCode = (u: unknown): number => {
  if (typeof u === "object" && u !== null && errorExitCode in u) {
    const code = u[errorExitCode]
    if (typeof code === "number") {
      return code
    }
  }
  return 1
}

/**
 * Type-level key for the `Runtime.errorReported` property that controls default
 * `runMain` error logging for an `Error`.
 *
 * @category Error reporting management
 * @since 4.0.0
 */
export type errorReported = "~effect/Runtime/errorReported"

/**
 * Runtime marker that controls default `runMain` error logging for an error.
 *
 * **Details**
 *
 * Set `[Runtime.errorReported]` to `false` on an error object to suppress the
 * runtime log because the error has already been reported. Omitted or
 * non-boolean values are treated as `true`, so failures are logged by default.
 *
 * **Example** (Suppressing error reporting)
 *
 * ```ts
 * import { Data, Effect, Runtime } from "effect"
 * import { NodeRuntime } from "@effect/platform-node"
 *
 * class MyError extends Data.TaggedError("MyError") {
 *   readonly [Runtime.errorReported] = false
 * }
 *
 * // If the program fails with MyError, the process will exit with code 1 but
 * // no error will be logged.
 * NodeRuntime.runMain(Effect.fail(new MyError()))
 * ```
 *
 * @category Error reporting management
 * @since 4.0.0
 */
export const errorReported: errorReported = "~effect/Runtime/errorReported"

/**
 * Reads the runtime error-reporting marker from an unknown error value.
 *
 * **Details**
 *
 * Returns a boolean `[Runtime.errorReported]` property when it is present on an
 * object. Otherwise returns `true`, so failures are logged by default.
 *
 * @category Error reporting management
 * @since 4.0.0
 */
export const getErrorReported = (u: unknown): boolean => {
  if (typeof u === "object" && u !== null && errorReported in u) {
    const isReported = u[errorReported]
    if (typeof isReported === "boolean") {
      return isReported
    }
  }
  return true
}
