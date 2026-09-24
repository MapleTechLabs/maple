import * as React from "react"
import { Result } from "@/lib/effect-atom"

import { listReplays } from "@/api/warehouse/replays"
import { listReplaysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { Effect } from "effect"
import { logClientError } from "@/lib/services/common/telemetry"
import { mapleRuntime } from "@/lib/registry"

/** Exported so the route loader prefetches the exact first-page key this hook reads. */
export const REPLAYS_PAGE_SIZE = 50
const PAGE_SIZE = REPLAYS_PAGE_SIZE
export const MAX_RETAINED_REPLAYS = 500

/**
 * The filter inputs the replays route already assembles (time window from
 * `useEffectiveTimeRange` + sidebar/search filters). Pagination params are added
 * by this hook — callers must not set `limit`/`cursor` themselves.
 */
export interface ReplaysFilterInputs {
	startTime: string
	endTime: string
	serviceName?: string
	browser?: string
	country?: string
	deviceType?: string
	userId?: string
	userSearch?: string
	visitorId?: string
	groupName?: string
	hasErrors?: boolean
	search?: string
	durationMinMs?: number
	durationMaxMs?: number
	activeTimeMinMs?: number
	activeTimeMaxMs?: number
}

type ReplaysPage = Effect.Success<ReturnType<typeof listReplays>>

const initialPagination = (filterKey: string, firstPage: ReplaysPage | undefined) => ({
	filterKey,
	firstPage,
	generation: Symbol(),
	additionalPages: [] as ReplaysPage[],
	isFetchingNextPage: false,
	stopped: false,
})

/** Cursor pagination, scoped to the current filters and refreshed first page. */
export function useInfiniteReplays(filterInputs: ReplaysFilterInputs) {
	const filterKey = React.useMemo(() => JSON.stringify(filterInputs), [filterInputs])
	const firstPageResult = useRefreshableAtomValue(
		listReplaysResultAtom({ data: { ...filterInputs, limit: PAGE_SIZE } }),
	)
	const firstPage = Result.isSuccess(firstPageResult) ? firstPageResult.value : undefined
	const [pagination, setPagination] = React.useState(() => initialPagination(filterKey, firstPage))
	const inFlightGeneration = React.useRef<symbol | null>(null)

	// Like the logs list, reset before committing a changed filter or first page.
	// A generation also distinguishes A → B → A from the original A request.
	if (pagination.filterKey !== filterKey || pagination.firstPage !== firstPage) {
		setPagination(initialPagination(filterKey, firstPage))
	}
	const { additionalPages, isFetchingNextPage, generation } = pagination
	const lastPage = additionalPages.at(-1) ?? firstPage
	const nextCursor = lastPage?.nextCursor ?? null
	const allData = React.useMemo(
		() =>
			[...(firstPage?.data ?? []), ...additionalPages.flatMap((page) => page.data)].slice(
				0,
				MAX_RETAINED_REPLAYS,
			),
		[firstPage, additionalPages],
	)
	const isCapped = allData.length >= MAX_RETAINED_REPLAYS
	const hasNextPage = !isCapped && !pagination.stopped && lastPage?.hasMore === true && nextCursor !== null

	const fetchNextPage = React.useCallback(() => {
		if (
			inFlightGeneration.current === generation ||
			firstPageResult.waiting ||
			!hasNextPage ||
			nextCursor === null
		)
			return
		inFlightGeneration.current = generation
		setPagination((current) => ({ ...current, isFetchingNextPage: true }))

		mapleRuntime
			.runPromise(listReplays({ data: { ...filterInputs, limit: PAGE_SIZE, cursor: nextCursor } }))
			.then((result) => {
				setPagination((current) =>
					current.generation === generation
						? {
								...current,
								additionalPages: [...current.additionalPages, result],
								stopped:
									result.hasMore &&
									result.nextCursor !== null &&
									(result.nextCursor === current.firstPage?.nextCursor ||
										current.additionalPages.some(
											(page) => page.nextCursor === result.nextCursor,
										)),
							}
						: current,
				)
			})
			.catch((error) => {
				if (inFlightGeneration.current !== generation) return
				setPagination((current) =>
					current.generation === generation ? { ...current, stopped: true } : current,
				)
				logClientError("replay.pagination_failed", error)
			})
			.finally(() => {
				if (inFlightGeneration.current !== generation) return
				inFlightGeneration.current = null
				setPagination((current) =>
					current.generation === generation ? { ...current, isFetchingNextPage: false } : current,
				)
			})
	}, [filterInputs, nextCursor, hasNextPage, generation, firstPageResult.waiting])

	return { firstPageResult, allData, isFetchingNextPage, hasNextPage, isCapped, fetchNextPage }
}
