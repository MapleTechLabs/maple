import { Array as Arr, Result, Schema } from "effect"

// An infinite list's pages after the first (`useInfinite*`): owned by one first page (`generation`),
// one fetch in flight at a time, stopped by a failed page. Traces, logs and replays share it; each
// page keeps its own cursor (an offset, a log cursor, a replay cursor) and its own "has more" rule.

/** The later pages' fields; a page whose pages are keyed by the first-page request adds `key`. */
export const laterPagesFields = <P extends Schema.Top>(page: P) => ({
	/** Bumped by every fresh set of pages: a page fetched for an earlier one is dropped. */
	generation: Schema.Number,
	pages: Schema.Array(page),
	isFetching: Schema.Boolean,
	/** A page failed: the list stops asking until the first page or filters change. */
	isStopped: Schema.Boolean,
})

export type LaterPages<A> = Readonly<{
	generation: number
	pages: ReadonlyArray<A>
	isFetching: boolean
	isStopped: boolean
}>

/** A fresh set of later pages for a new first page. */
export const freshLaterPages = (generation: number): LaterPages<never> => ({
	generation,
	pages: [],
	isFetching: false,
	isStopped: false,
})

/** The next page's request went out. */
export const fetchingNext = <S extends LaterPages<unknown>>(pages: S): S => ({ ...pages, isFetching: true })

/**
 * A next page answered: appended, or a failure stops paging. `stopsAt` decides `isStopped` from a
 * page that succeeded (replays stop on a repeated cursor); without it the flag is kept.
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
		onFailure: () => ({ ...pages, isFetching: false, isStopped: true }),
	})

/** `allData`: the first page's rows then every later page's, capped. */
export const pagedRows = <A, R>(
	first: ReadonlyArray<R>,
	pages: ReadonlyArray<A>,
	rowsOf: (page: A) => ReadonlyArray<R>,
	cap: number,
): ReadonlyArray<R> => [...first, ...Arr.flatMap(pages, rowsOf)].slice(0, cap)
