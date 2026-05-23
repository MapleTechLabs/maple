/**
 * Node.js implementation of the Effect `Stdio` service.
 *
 * This module exposes a layer that connects `Stdio` to the current process:
 * command-line arguments come from `process.argv`, input is read from
 * `process.stdin`, and output and error output write to `process.stdout` and
 * `process.stderr`. It is intended for CLIs, scripts, command runners, and
 * other process-oriented programs that need standard input and output through
 * Effect services.
 *
 * The underlying streams are owned by the Node process. The layer keeps stdin
 * open and does not end stdout or stderr when a stream finishes, which avoids
 * closing global process handles that other code may still use. Be mindful that
 * stdio may be a pipe, file, or TTY, so terminal-specific behavior such as raw
 * mode, echo, colors, and cursor control should be handled with the terminal
 * APIs instead of assuming an interactive console.
 *
 * @since 4.0.0
 */
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import type * as Layer from "effect/Layer"
import type { Stdio } from "effect/Stdio"

/**
 * Provides the `Stdio` service backed by the current process arguments,
 * stdin, stdout, and stderr streams.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Stdio> = NodeStdio.layer
