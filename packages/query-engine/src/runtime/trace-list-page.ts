// Cutting a trace-list page from two sources
//
// A page is cut from root spans. Traces with no root span are found among the
// entry spans near the page and merged in by position, so the check that a
// trace has no root is paid for one page's candidates, never for the window.

import { DateTime } from "effect"
import type { TraceListPositionOutput } from "../ch/queries/traces"

export interface TraceListSort {
	readonly sortBy: "timestamp" | "durationMs"
	readonly sortDir: "asc" | "desc"
}

/**
 * Entry spans read per page slot: a trace can have several, and most belong to
 * traces that do have a root.
 */
export const ENTRY_ROWS_PER_SLOT = 4
/** Most entry spans one page reads, and most candidate traces it checks for a root. */
export const ENTRY_ROW_LIMIT = 4_000
export const CANDIDATE_LIMIT = 2_000

/** Stage 1's order: negative when `a` is listed before `b`. */
export const byPosition =
	({ sortBy, sortDir }: TraceListSort) =>
	(a: TraceListPositionOutput, b: TraceListPositionOutput): number => {
		const sign = sortDir === "desc" ? -1 : 1
		const byDuration = sortBy === "durationMs" ? sign * (a.d - b.d) : 0
		const byStart = sign * (DateTime.toEpochMillis(a.ts) - DateTime.toEpochMillis(b.ts))
		// TraceId always descends, as in the SQL.
		return byDuration || byStart || (a.traceId < b.traceId ? 1 : a.traceId > b.traceId ? -1 : 0)
	}

export interface RootlessCandidates {
	/** One per trace, where it would be listed, among the positions the page can reach. */
	readonly candidates: ReadonlyArray<TraceListPositionOutput>
	/**
	 * Set when the entry spans the page could reach were not all read or kept:
	 * the last position down to which the candidates are complete.
	 */
	readonly completeThrough: TraceListPositionOutput | undefined
}

/**
 * The traces a page could list by an entry span: the first entry span of each
 * trace in page order, down to the page's last root (`roots` holds
 * `offset + limit` of them when the page is full; with fewer, every root is in
 * hand and the page runs to the end of the window).
 */
export const rootlessCandidates = (
	sort: TraceListSort,
	entryRows: ReadonlyArray<TraceListPositionOutput>,
	rowLimit: number,
	roots: ReadonlyArray<TraceListPositionOutput>,
	pageEnd: number,
): RootlessCandidates => {
	const before = byPosition(sort)
	const lastRoot = roots.length >= pageEnd ? roots[pageEnd - 1] : undefined
	const seen = new Set<string>()
	const reachable = entryRows.filter((row) => {
		if (seen.has(row.traceId)) return false
		seen.add(row.traceId)
		return lastRoot === undefined || before(row, lastRoot) < 0
	})
	if (reachable.length > CANDIDATE_LIMIT) {
		const candidates = reachable.slice(0, CANDIDATE_LIMIT)
		return { candidates, completeThrough: candidates.at(-1) }
	}
	// A full read that stops before the page's last root may have missed entry spans.
	const lastRead = entryRows.at(-1)
	const readShort =
		entryRows.length >= rowLimit &&
		lastRead !== undefined &&
		(lastRoot === undefined || before(lastRead, lastRoot) < 0)
	return { candidates: reachable, completeThrough: readShort ? lastRead : undefined }
}

/** Both inputs in page order; the page is positions `[offset, offset + limit)` of their merge. */
export const mergedPage = (
	sort: TraceListSort,
	roots: ReadonlyArray<TraceListPositionOutput>,
	rootless: ReadonlyArray<TraceListPositionOutput>,
	offset: number,
	limit: number,
): ReadonlyArray<TraceListPositionOutput> =>
	[...roots, ...rootless].sort(byPosition(sort)).slice(offset, offset + limit)

/**
 * Whether a page cut from incomplete candidates is still exact: it is when it
 * is full and ends no later than the candidates are complete through.
 */
export const pageIsExact = (
	sort: TraceListSort,
	page: ReadonlyArray<TraceListPositionOutput>,
	limit: number,
	completeThrough: TraceListPositionOutput | undefined,
): boolean => {
	if (completeThrough === undefined) return true
	const last = page.at(-1)
	return page.length === limit && last !== undefined && byPosition(sort)(last, completeThrough) <= 0
}
