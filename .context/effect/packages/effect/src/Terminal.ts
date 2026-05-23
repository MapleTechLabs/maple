/**
 * The `Terminal` module defines the service interface used by platform
 * integrations to model command-line input and output. It gives programs a
 * uniform way to query terminal dimensions, read lines, stream low-level key
 * events, and write text without depending directly on Node, the browser, or a
 * test-specific console implementation.
 *
 * Use this module when building interactive command-line tools, prompts, or
 * platform abstractions that need terminal capabilities as an Effect service.
 * Implementations are supplied through context, so application code can depend
 * on `Terminal` while tests and runtimes provide the concrete behavior.
 *
 * `readLine` can fail with {@link QuitError} when the user requests to quit,
 * commonly via `Ctrl+C`. For lower-level interaction, `readInput` returns a
 * scoped stream of {@link UserInput} values containing parsed key metadata and
 * any raw character input.
 *
 * @since 4.0.0
 */
import type * as Cause from "./Cause.ts"
import * as Context from "./Context.ts"
import type * as Effect from "./Effect.ts"
import type * as Option from "./Option.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Predicate from "./Predicate.ts"
import type * as Queue from "./Queue.ts"
import * as Schema from "./Schema.ts"
import type * as Scope from "./Scope.ts"

const TypeId = "~effect/platform/Terminal"

/**
 * A `Terminal` represents a command-line interface which can read input from a
 * user and display messages to a user.
 *
 * @category models
 * @since 4.0.0
 */
export interface Terminal {
  readonly [TypeId]: typeof TypeId

  /**
   * The number of columns available on the platform's terminal interface.
   */
  readonly columns: Effect.Effect<number>
  /**
   * The number of rows available on the platform's terminal interface.
   */

  readonly rows: Effect.Effect<number>
  /**
   * Reads input events from the default standard input.
   */
  readonly readInput: Effect.Effect<Queue.Dequeue<UserInput, Cause.Done>, never, Scope.Scope>
  /**
   * Reads a single line from the default standard input.
   */
  readonly readLine: Effect.Effect<string, QuitError>
  /**
   * Displays text to the default standard output.
   */
  readonly display: (text: string) => Effect.Effect<void, PlatformError>
}

/**
 * Keyboard key metadata for terminal input, including the key name and
 * modifier state.
 *
 * @category models
 * @since 4.0.0
 */
export interface Key {
  /**
   * The name of the key being pressed.
   */
  readonly name: string
  /**
   * If set to `true`, then the user is also holding down the `Ctrl` key.
   */
  readonly ctrl: boolean
  /**
   * If set to `true`, then the user is also holding down the `Meta` key.
   */
  readonly meta: boolean
  /**
   * If set to `true`, then the user is also holding down the `Shift` key.
   */
  readonly shift: boolean
}

/**
 * A terminal input event containing an optional raw character and the parsed
 * key that was pressed.
 *
 * @category models
 * @since 4.0.0
 */
export interface UserInput {
  /**
   * The character read from the user (if any).
   */
  readonly input: Option.Option<string>
  /**
   * The key that the user pressed.
   */
  readonly key: Key
}

const QuitErrorTypeId = "effect/platform/Terminal/QuitError"

/**
 * A `QuitError` represents an error that occurs when a user attempts to
 * quit out of a `Terminal` prompt for input (usually by entering `ctrl`+`c`).
 *
 * @category QuitError
 * @since 4.0.0
 */
export class QuitError extends Schema.ErrorClass<QuitError>("QuitError")({
  _tag: Schema.tag("QuitError")
}) {
  /**
   * Marks this value as a terminal quit error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [QuitErrorTypeId] = QuitErrorTypeId
}

/**
 * Returns `true` if the provided value is a `Terminal.QuitError`.
 *
 * @category QuitError
 * @since 4.0.0
 */
export const isQuitError = (u: unknown): u is QuitError => Predicate.hasProperty(u, QuitErrorTypeId)

/**
 * Context service tag for accessing a `Terminal` implementation.
 *
 * @category services
 * @since 4.0.0
 */
export const Terminal: Context.Service<Terminal, Terminal> = Context.Service("effect/platform/Terminal")

/**
 * Creates a Terminal implementation
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  impl: Omit<Terminal, typeof TypeId>
): Terminal => Terminal.of({ ...impl, [TypeId]: TypeId })
