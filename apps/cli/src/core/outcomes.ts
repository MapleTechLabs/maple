import { Cause, Effect, Option } from "effect"
import { describeFailure, formatFailure } from "../lib/failure"

/**
 * Expected-outcome handling for the root `maple` span.
 *
 * A CLI failure is not automatically a *problem*. Refusing to start because the
 * server is already running, reporting that no backend is configured, a bad
 * `--since`: these are the CLI working, but they travel through Effect's error
 * channel, so `Effect.withSpan("maple", …)` in bin.ts closed the root span
 * `Error` for every one of them and buried the failures worth acting on.
 *
 * These helpers recover such outcomes *inside* the span, the same placement
 * bin.ts uses for `ArchiveError`: applied outside, the span has already closed
 * by the time recovery runs.
 *
 * They live in their own module because bin.ts executes the CLI at import time
 * and cannot be imported by a test.
 */

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
				process.exitCode = 1
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
