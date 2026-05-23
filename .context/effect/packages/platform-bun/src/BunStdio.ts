/**
 * Bun-backed implementation of Effect's `Stdio` service.
 *
 * This module provides the process stdio layer for Bun applications by reusing
 * the shared Node-compatible implementation. The layer connects `Stdio` to the
 * current Bun process: arguments come from `process.argv`, input is read from
 * `process.stdin`, and output and error output write to `process.stdout` and
 * `process.stderr`. It is intended for CLIs, scripts, command runners, test
 * harnesses, and other process-oriented programs that need standard input and
 * output through Effect services.
 *
 * The underlying stdio streams are global resources owned by the Bun process.
 * The layer keeps stdin open and does not end stdout or stderr by default,
 * which avoids closing handles that prompts, loggers, or other code may still
 * use. Stdio may be attached to a TTY, pipe, or redirected file, so
 * terminal-specific behavior such as raw mode, echo, colors, cursor control,
 * and terminal dimensions should be coordinated with terminal APIs rather than
 * assumed from this layer.
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
