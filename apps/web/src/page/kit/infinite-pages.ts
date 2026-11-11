import { Array as Arr, Result, Schema } from "effect"

// An infinite list's pages after the first: owned by one first page (`generation`), one fetch in
// flight at a time, paused by a failed page until a retry. Traces, logs and replays share it; each
// page keeps its own cursor (an offset, a log cursor, a replay cursor) and its own "has more" rule.

/** The later pages' fields; a page whose pages are keyed by the first-page request adds `key`. */
export const laterPagesFields = <P extends Schema.Top>(page: P) => ({
	/** Bumped by every fresh set of pages: a page fetched for an earlier one is dropped. */
	generation: Schema.Number,
	pages: Schema.Array(page),
	isFetching: Schema.Boolean,
	/** The last page request failed: the list asks again only on a retry, and its footer says so. */
	isFailed: Schema.Boolean,
	/** A page said the list ends here (replays: a repeated cursor). */
	isStopped: Schema.Boolean,
})

export type LaterPages<A> = Readonly<{
	generation: number
	pages: ReadonlyArray<A>
	isFetching: boolean
	isFailed: boolean
	isStopped: boolean
}>

/** A fresh set of later pages for a new first page. */
export const freshLaterPages = (generation: number): LaterPages<never> => ({
	generation,
	pages: [],
	isFetching: false,
	isFailed: false,
	isStopped: false,
})

/** The next page's request went out; a retry clears the failure it answers. */
export const fetchingNext = <S extends LaterPages<unknown>>(pages: S): S => ({
	...pages,
	isFetching: true,
	isFailed: false,
})

/**
 * A next page answered: appended, or the failure is kept for the footer's retry. `stopsAt` decides
 * `isStopped` from a page that succeeded (replays stop on a repeated cursor); without it the flag is kept.
 */
export const appendedPage = <A, S extends LaterPages<A>>(
	pages: S,
	result: Result.Result<A, unknown>,
	stopsAt?: (page: A) => boolean,
): S =>
	Result.match(result, {
		onSuccess: (page) => ({
			...pages,
			pages: [...pages.pages, page],
			isFetching: false,
			isStopped: stopsAt === undefined ? pages.isStopped : stopsAt(page),
		}),
		onFailure: () => ({ ...pages, isFetching: false, isFailed: true }),
	})

/** The first page's rows then every later page's, capped. */
export const pagedRows = <A, R>(
	first: ReadonlyArray<R>,
	pages: ReadonlyArray<A>,
	rowsOf: (page: A) => ReadonlyArray<R>,
	cap: number,
): ReadonlyArray<R> => [...first, ...Arr.flatMap(pages, rowsOf)].slice(0, cap)
