/**
 * Shared Node.js implementation of the Effect `Stdio` service.
 *
 * This module builds the `Stdio` layer used by Node platform packages by
 * wiring the service to the current process: command-line arguments come from
 * `process.argv`, input is read from `process.stdin`, and output and error
 * output are written to `process.stdout` and `process.stderr`. It is intended
 * for CLIs, scripts, command runners, test harnesses, and other
 * process-oriented programs that need standard I/O through Effect services.
 *
 * The process stdio streams are global resources owned by Node. This layer
 * leaves stdin open and does not end stdout or stderr by default, avoiding
 * accidental closure of handles other code in the process may still use. Those
 * streams may be pipes, files, or TTYs; interactive terminal behavior such as
 * raw mode, echo, colors, and cursor movement should be coordinated with the
 * terminal APIs instead of assuming this layer has exclusive control.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { systemError } from "effect/PlatformError"
import * as Stdio from "effect/Stdio"
import { fromWritable } from "./NodeSink.ts"
import { fromReadable } from "./NodeStream.ts"

/**
 * Provides `Stdio` from `process.argv`, `process.stdin`, `process.stdout`,
 * and `process.stderr`; stdin remains open and stdout/stderr are not ended by
 * default.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Stdio.Stdio> = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.sync(() => process.argv.slice(2)),
    stdout: (options) =>
      fromWritable({
        evaluate: () => process.stdout,
        onError: (cause) =>
          systemError({
            module: "Stdio",
            method: "stdout",
            _tag: "Unknown",
            cause
          }),
        endOnDone: options?.endOnDone ?? false
      }),
    stderr: (options) =>
      fromWritable({
        evaluate: () => process.stderr,
        onError: (cause) =>
          systemError({
            module: "Stdio",
            method: "stderr",
            _tag: "Unknown",
            cause
          }),
        endOnDone: options?.endOnDone ?? false
      }),
    stdin: fromReadable({
      evaluate: () => process.stdin,
      onError: (cause) =>
        systemError({
          module: "Stdio",
          method: "stdin",
          _tag: "Unknown",
          cause
        }),
      closeOnDone: false
    })
  })
)
