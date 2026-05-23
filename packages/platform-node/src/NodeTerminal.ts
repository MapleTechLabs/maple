/**
 * Provides the Node.js `Terminal` service for interactive command-line
 * programs, prompts, and tools that need to read lines, react to key presses,
 * write to stdout, or inspect terminal dimensions.
 *
 * The implementation is backed by the current process' stdin and stdout. When
 * stdin is a TTY, key input temporarily enables raw mode for the scope of the
 * service, so callers should acquire it with a scope or use the provided layer
 * to ensure terminal state is restored. In non-TTY environments, terminal
 * dimensions may be reported as zero and raw-mode key handling is unavailable.
 *
 * @since 4.0.0
 */
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import type { Effect } from "effect/Effect"
import type { Layer } from "effect/Layer"
import type { Scope } from "effect/Scope"
import type { Terminal, UserInput } from "effect/Terminal"

/**
 * Creates a scoped `Terminal` service backed by process stdin/stdout, using the
 * optional predicate to decide when key input should end the input stream.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (shouldQuit?: (input: UserInput) => boolean) => Effect<Terminal, never, Scope> = NodeTerminal.make

/**
 * Provides the default process-backed `Terminal` service, ending key input on
 * the default quit keys.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer<Terminal> = NodeTerminal.layer
