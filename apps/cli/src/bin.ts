#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Console, Effect, Exit, Layer, Logger, Metric, Runtime } from "effect"
import * as CliOutput from "effect/unstable/cli/CliOutput"
import * as Command from "effect/unstable/cli/Command"
import { FetchHttpClient } from "effect/unstable/http"
import { cli } from "./cli"
import { MapleConfig } from "./core/config"
import { Mode } from "./core/mode"
import { annotateOutcome, isExpectedFailure, recoverExpected, renderUnexpected } from "./core/outcomes"
import { TelemetryLayer } from "./core/telemetry"
import { maybeNotifyUpdate } from "./core/update"
import { WarehouseExecutorFromMode } from "./core/warehouse"
import { debugEnabled } from "./lib/debug"
import { makeHelpCapture, usageHint } from "./lib/help"
import { archiveErrorMessage } from "./server/archives/errors"
import { CHECKPOINT_REOPEN_PROBE_ENV, validateCheckpointDataDir } from "./server/checkpoints"
import { MAPLE_VERSION } from "./version"

// WarehouseExecutorFromMode needs Mode (which needs MapleConfig). provideMerge
// keeps Mode + MapleConfig in the output context too, so the login/logout/whoami
// commands can read them directly. The executor's backend is resolved lazily on
// first query, so commands that never query work even with no backend configured.
const MainLayer = WarehouseExecutorFromMode.pipe(
	Layer.provideMerge(Mode.layer),
	Layer.provideMerge(MapleConfig.layer),
	Layer.provideMerge(BunServices.layer),
	Layer.provideMerge(FetchHttpClient.layer),
)

// Throttled, non-blocking "update available" notice before dispatching the
// command. It never fails and short-circuits to a cached decision on most runs
// (network is hit at most once per 24h), so the latency cost is negligible.
//
// `cli.argv` records the sub-command + flags so one root span per invocation
// ties a command to the warehouse queries it runs. TelemetryLayer is provided
// OUTERMOST (after MainLayer), not merged into it: the OTLP tracer's batch
// exporter flushes when its layer scope closes, and only the outermost provide's
// scope is the runtime's main scope that `BunRuntime.runMain` closes on exit.
// Merging it into MainLayer leaves spans unflushed for short-lived commands.
const checkpointProbeDataDir = process.env[CHECKPOINT_REOPEN_PROBE_ENV]
const cliInvocations = Metric.counter("cli.invocations_total", {
	description: "Total Maple CLI command invocations",
	incremental: true,
}).pipe(Metric.withConstantInput(1))
const cliInvocationDuration = Metric.timer("cli.invocation_duration", {
	description: "Maple CLI command duration",
})

if (checkpointProbeDataDir !== undefined) {
	// Private re-exec path used by checkpoint restore. It intentionally bypasses
	// CLI dispatch, update checks, telemetry, and schema bootstrap: success means
	// this new process loaded the persisted restored representation and queried
	// its core tables before closing chDB cleanly.
	try {
		process.stdout.write(`${JSON.stringify(validateCheckpointDataDir(checkpointProbeDataDir))}\n`)
	} catch (error) {
		process.stderr.write(
			`checkpoint reopen probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
		)
		process.exitCode = 1
	}
} else {
	const help = makeHelpCapture()

	// `maple stop` ends a foreground server with SIGTERM. That is a clean
	// shutdown, so it exits 0; Ctrl+C (SIGINT) keeps the conventional 130.
	let terminated = false
	process.once("SIGTERM", () => {
		terminated = true
	})
	const teardown: Runtime.Teardown = (exit, onExit) =>
		terminated && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
			? onExit(0)
			: Runtime.defaultTeardown(exit, onExit)

	/* oxlint-disable effecttsgo/multiple-effect-provide */
	/* oxlint-disable effecttsgo/strict-effect-provide */
	maybeNotifyUpdate.pipe(
		Effect.flatMap(() =>
			Command.run(cli, { version: MAPLE_VERSION }).pipe(
				Effect.track(cliInvocations),
				Effect.trackDuration(cliInvocationDuration),
			),
		),
		// Holds the help page back until we know whether it was asked for (see lib/help.ts).
		Effect.provideService(CliOutput.Formatter, help.formatter),
		Effect.provideService(Console.Console, help.console),
		// The recovery sits *inside* the span: applied outside it, a gracefully
		// handled archive error still closed the root span as Error.
		Effect.catchTag("@maple/cli/ArchiveError", (error) =>
			Effect.sync(() => {
				process.stderr.write(archiveErrorMessage(error))
				process.exitCode = 1
			}),
		),
		// `Command.runWith` renders help and then re-fails with the same error, so
		// `maple --help` recorded as an error span. Only the exit code is left to
		// honour: 0 for a bare group command, 1 when parsing failed. The tag is
		// "ShowHelp"; `~effect/cli/CliError/ShowHelp` is the schema identifier.
		Effect.catchTag("ShowHelp", (error) =>
			annotateOutcome(error._tag).pipe(
				Effect.andThen(
					Effect.sync(() => {
						if (error.errors.length > 0) {
							help.discard()
							process.stderr.write(usageHint(error.commandPath))
						}
						process.exitCode = Runtime.getErrorExitCode(error)
					}),
				),
			),
		),
		// Expected outcomes, recovered inside the span for the same reason: a
		// refused precondition, no backend, a bad `--since`, a trace that is not
		// there. They are the CLI behaving correctly, and closing the root span
		// `Error` for them buried real failures (~24k events for the
		// already-running guard alone). `maple.cli.outcome` still records them.
		Effect.catchIf(isExpectedFailure, recoverExpected),
		Effect.ensuring(Effect.sync(help.flush)),
		Effect.withSpan("maple", { attributes: { "cli.argv": process.argv.slice(2).join(" ") } }),
		Effect.provide(MainLayer),
		Effect.provide(TelemetryLayer),
		// Genuine failures reach here after closing the root span `Error`, each
		// under its own tag (see `commands/server-errors.ts`). They still print
		// one `error:` line; the cause and stack are behind `--debug`.
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.failCause(cause)
				: Effect.sync(() => {
						process.stderr.write(renderUnexpected(cause, debugEnabled()))
						process.exitCode = 1
					}),
		),
		// Logs are diagnostics, never results: keep them off stdout.
		Effect.provideService(Logger.LogToStderr, true),
		BunRuntime.runMain({ teardown }),
	)
	/* oxlint-enable effecttsgo/strict-effect-provide */
	/* oxlint-enable effecttsgo/multiple-effect-provide */
}
