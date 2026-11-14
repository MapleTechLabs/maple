import { Cause, Effect, Option } from "effect"
import { describeFailure, formatFailure } from "../lib/failure"

/**
 * Expected outcomes (already running, no backend, a bad `--since`) are the CLI working, so they are
 * recovered inside the root `maple` span to leave it `Ok`. Kept out of bin.ts, which runs the CLI
 * at import time and so cannot be imported by a test.
 */

/**
 * Exit status for a `maple start` refusal that retrying cannot fix (sysexits
 * EX_CONFIG). A supervisor can treat it as final, e.g. systemd
 * `RestartPreventExitStatus=78`.
 */
export const EXIT_START_REFUSED = 78

/** Exit non-zero, keeping a more specific status a handler already chose. */
export const markFailedExit = (): void => {
	const current = typeof process.exitCode === "number" ? process.exitCode : 0
	process.exitCode = current === 0 ? 1 : current
}

/** Record which expected outcome ended the run, on the root `maple` span. */
export const annotateOutcome = (tag: string): Effect.Effect<void> =>
	Effect.annotateCurrentSpan({ "maple.cli.outcome": tag })

/** Whether a failure is the CLI working correctly (bad input, nothing running, not found). */
export const isExpectedFailure = (error: unknown): boolean => describeFailure(error).expected

/**
 * Recover an expected, user-facing outcome: annotate it, print `error: …` (and
 * a hint) on stderr, and exit non-zero while leaving the root span `Ok`.
 */
export const recoverExpected = (error: unknown): Effect.Effect<void> => {
	const report = describeFailure(error)
	return annotateOutcome(report.tag).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.stderr.write(formatFailure(report))
				markFailedExit()
			}),
		),
	)
}

/**
 * The stderr text for a failure that escaped every handler: one `error:` line
 * and a hint, with Effect's cause and stack only under `--debug`.
 */
export const renderUnexpected = (cause: Cause.Cause<unknown>, debug: boolean): string => {
	const failure = Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause))
	const text = formatFailure(describeFailure(failure))
	return debug ? `${Cause.pretty(cause)}\n${text}` : text
}
