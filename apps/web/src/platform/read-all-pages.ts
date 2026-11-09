import { Effect } from "effect"

// Reads a v2 cursor-paginated list to the end.

/** Pages read at most per list: 2000 rows at the maximum limit, far past what an org holds. */
export const MAX_LIST_PAGES = 20

export interface ListPage<A> {
	readonly data: ReadonlyArray<A>
	readonly has_more: boolean
	readonly next_cursor: string | null
}

/** Every row of a list, following `next_cursor` until `has_more` is false or the page cap. */
export const readAllPages = <A, E, R>(
	read: (cursor: string | undefined) => Effect.Effect<ListPage<A>, E, R>,
	cursor?: string,
	pages = 1,
): Effect.Effect<ReadonlyArray<A>, E, R> =>
	Effect.flatMap(read(cursor), (response) =>
		response.has_more && response.next_cursor !== null && pages < MAX_LIST_PAGES
			? Effect.map(readAllPages(read, response.next_cursor, pages + 1), (rest) => [
					...response.data,
					...rest,
				])
			: Effect.succeed(response.data),
	)
