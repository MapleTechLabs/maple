/**
 * When a run that still says `investigating` has been abandoned.
 *
 * One module because it used to live in two and they drifted. Both the
 * incident-open path and `InvestigationService` import from here.
 */

/** One agent pass. If it has not answered in this long, it is not going to. */
export const STALE_MS = 15 * 60 * 1000

export const staleTimeoutMessage = (budgetMs: number): string =>
	`diagnosis_timeout: no diagnosis was submitted within ${Math.round(budgetMs / 60_000)} minutes; retry`

/** True when this row has outlived the pass budget. */
export const isInvestigationStale = (
	row: { readonly status: string; readonly startedAt: Date | null },
	nowMs: number,
): boolean =>
	row.status === "investigating" && row.startedAt !== null && row.startedAt.getTime() < nowMs - STALE_MS
