/**
 * What the peek sheet needs to open a trace: its id, and (when known) a
 * timestamp inside it so the hierarchy query prunes to one partition window.
 * A row from the list supplies both; a URL for a row that is not loaded may
 * only supply the id.
 */
export interface PeekTarget {
	readonly traceId: string
	readonly startTime?: string
}

/** The `peek*` search params on the traces list. */
export interface PeekSearch {
	readonly peek?: string
	readonly peekRow?: string
	readonly peekT?: string
}

/** The slice of a list row the peek cares about. */
export interface PeekRow {
	readonly traceId: string
	readonly spanId: string
	readonly isRootSpan: boolean
	readonly startTime: string
}

export interface ResolvedPeek<R extends PeekRow> {
	readonly target: PeekTarget
	/** Where the row sits in the loaded list; `null` when the URL names a row that is not loaded. */
	readonly position: { readonly index: number; readonly count: number } | null
	readonly row: R | null
}

/** The params that pin a row: the trace, and the row's own span when the list is per-span. */
export function peekParamsFor(
	trace: PeekRow,
): Required<Pick<PeekSearch, "peek" | "peekT">> & Pick<PeekSearch, "peekRow"> {
	return {
		peek: trace.traceId,
		peekT: trace.startTime,
		// Grouped rows are one per trace, so the trace id is the row. With
		// `rootOnly` off several rows share a trace and the span tells them apart.
		peekRow: trace.isRootSpan ? undefined : trace.spanId,
	}
}

/**
 * Which row the URL's peek refers to, against the rows on screen.
 *
 * A trace id can match several rows in the per-span list; `peekRow` picks the
 * one that was opened, and without it the first match wins. A peek whose row
 * is not loaded (a shared link into page three, or the filter changed under
 * it) still opens the trace from the id and `peekT`, just without a position —
 * the arrows have nothing to step to, and the sheet says so by disabling them.
 */
export function resolvePeek<R extends PeekRow>(
	rows: ReadonlyArray<R>,
	search: PeekSearch,
): ResolvedPeek<R> | null {
	if (!search.peek) return null
	const matches: number[] = []
	rows.forEach((row, index) => {
		if (row.traceId === search.peek) matches.push(index)
	})
	const index =
		(search.peekRow ? matches.find((i) => rows[i]?.spanId === search.peekRow) : undefined) ?? matches[0]
	const row = index === undefined ? null : (rows[index] ?? null)
	if (row === null || index === undefined) {
		return { target: { traceId: search.peek, startTime: search.peekT }, position: null, row: null }
	}
	return {
		target: { traceId: row.traceId, startTime: row.startTime },
		position: { index, count: rows.length },
		row,
	}
}
