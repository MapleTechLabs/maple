import type { ErrorIssueId } from "@maple/domain/http"
import { Effect, Exit } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"

/** Parallel calls per bulk action; the API serialises each issue's row anyway. */
export const BULK_CONCURRENCY = 4

export const ISSUES_KEY = "errorIssues"
export const issueKey = (issueId: ErrorIssueId) => `errorIssue:${issueId}`

/**
 * One bulk action is ONE atom run, never N writes to a per-issue mutation atom.
 * An `Atom.fn` is not concurrent: each write interrupts the fiber of the
 * previous one and every pending `promiseExit` resolves with the LAST result,
 * so `Promise.all(ids.map(set))` moved one issue and toasted that it moved all.
 *
 * Every issue gets its own `Exit`, so a partial failure is reported per row,
 * and the list is invalidated once at the end rather than once per issue.
 */
export const forEachIssue = <A, E, R>(
	issueIds: ReadonlyArray<ErrorIssueId>,
	run: (issueId: ErrorIssueId) => Effect.Effect<A, E, R>,
): Effect.Effect<ReadonlyArray<Exit.Exit<A, E>>, never, R | Reactivity.Reactivity> =>
	Reactivity.mutation(
		Effect.forEach(issueIds, (issueId) => Effect.exit(run(issueId)), { concurrency: BULK_CONCURRENCY }),
		[ISSUES_KEY, ...issueIds.map(issueKey)],
	)

export interface BatchOutcome {
	readonly succeeded: number
	readonly failed: number
	/** The first failure, for the toast; undefined when every issue succeeded. */
	readonly firstFailure: Exit.Exit<unknown, unknown> | undefined
}

/** Folds the per-issue exits (or the batch's own failure) into counts for the toast. */
export const batchOutcome = (
	total: number,
	exit: Exit.Exit<ReadonlyArray<Exit.Exit<unknown, unknown>>, unknown>,
	onFailure: (failure: Exit.Exit<unknown, unknown>) => void,
): BatchOutcome => {
	if (Exit.isFailure(exit)) {
		onFailure(exit)
		return { succeeded: 0, failed: total, firstFailure: exit }
	}
	const failures = exit.value.filter(Exit.isFailure)
	failures.forEach(onFailure)
	return { succeeded: total - failures.length, failed: failures.length, firstFailure: failures[0] }
}
