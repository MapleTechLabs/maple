/**
 * Bun-backed implementation of Effect's `Terminal` service.
 *
 * This module provides a scoped, process-backed terminal for Bun programs by
 * adapting the runtime's Node-compatible stdin, stdout, and `readline` support.
 * It is useful for CLIs, prompts, REPLs, and terminal interfaces that need
 * prompt output, line input, keypress input, or terminal dimensions.
 *
 * The service uses the current process streams, so acquire it with a scope or
 * provide `layer` to ensure cleanup. When stdin is attached to a TTY, raw mode
 * is enabled while the terminal is active and restored when the scope closes;
 * this changes how keys are delivered and can affect other consumers of stdin.
 * In pipes, redirected input, or CI, raw mode may be unavailable, keypress input
 * is limited, and stdout dimensions may be reported as zero.
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
