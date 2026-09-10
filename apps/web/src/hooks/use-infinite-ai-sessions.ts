import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { AI_SESSION_DETAILS_MAX_SESSIONS, type AiSessionDetailsItem } from "@maple/domain/http"

import { getAiSessionDetails, listAiSessions, type ListAiSessionsInput } from "@/api/warehouse/ai-sessions"
import { listAiSessionsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { logClientError } from "@/lib/services/common/telemetry"
import { mapleRuntime } from "@/lib/registry"

export const AI_SESSIONS_PAGE_SIZE = 50
const PAGE_SIZE = AI_SESSIONS_PAGE_SIZE
export const MAX_RETAINED_AI_SESSIONS = 500

/**
 * The filter inputs the agent-sessions route assembles (resolved time window +
 * sidebar filters + sort). Pagination params are added by this hook — callers
 * must not set `limit`/`offset` themselves.
 */
export type AiSessionsFilterInputs = Omit<
	ListAiSessionsInput,
	"limit" | "offset" | "startTime" | "endTime"
> & {
	startTime: string
	endTime: string
}

interface AiSessionsPage {
	data: ReadonlyArray<AgentSessionRow>
	/** Sessions the server ranked for this page — what paging counts, since
	 *  `data` can run short of it (see `ListAiSessionsResponse.ranked`). */
	ranked: number
}

/** The pages fetched past the first, tagged with the filters they belong to:
 *  a filter change resets them on the next render, and until then nothing
 *  may read them as the new filters' rows. */
interface AdditionalPages {
	key: string
	pages: ReadonlyArray<AiSessionsPage>
}

const NO_PAGES: ReadonlyArray<AiSessionsPage> = []

/** A page's ranked count, falling back to its row count for a server that
 *  predates the field. */
const rankedOf = (page: { data: ReadonlyArray<unknown>; ranked?: number }) => page.ranked ?? page.data.length

/**
 * Offset-based infinite scroll for the agent-sessions list, mirroring
 * `useInfiniteReplays`. The first page flows through the cached result atom (so
 * it shares the route's skeleton/refresh semantics); later pages are fetched
 * imperatively and accumulated. Pages reset whenever the filter inputs change.
 *
 * A page renders from the index-only read and is then detailed: once its rows
 * are on screen, one request per page fetches what only the traces' other
 * spans can say (`getAiSessionDetails`), and each row takes the figures that
 * come back in place of its agent-only ones. A page whose details never come
 * keeps the index's figures — the list is already usable.
 *
 * Details depend on the session and the counted filters alone, so they
 * outlive a sort or window change: only a counted-filter change discards them.
 */
export function useInfiniteAiSessions(filterInputs: AiSessionsFilterInputs) {
	const filterKey = React.useMemo(() => JSON.stringify(filterInputs), [filterInputs])
	const countedFilters = React.useMemo(() => {
		const { vendorIds, serviceNames, deploymentEnvs, models, agentNames, toolNames, search } = filterInputs
		return { vendorIds, serviceNames, deploymentEnvs, models, agentNames, toolNames, search }
	}, [filterInputs])
	const detailsKey = React.useMemo(() => JSON.stringify(countedFilters), [countedFilters])

	// Refreshable AND retained: on an absolute time range the atom key never
	// rolls, so Reload only works through the refresh subscription; and a filter
	// change builds a new key whose first read is `Initial`, which retention
	// turns into a dimmed list rather than a skeleton flash.
	const firstPageResult = useRefreshableAtomValue(
		listAiSessionsResultAtom({ data: { ...filterInputs, limit: PAGE_SIZE, offset: 0 } }),
	)

	const [additionalPages, setAdditionalPages] = React.useState<AdditionalPages>({ key: filterKey, pages: NO_PAGES })
	const [isFetchingNextPage, setIsFetchingNextPage] = React.useState(false)
	const [paginationStopped, setPaginationStopped] = React.useState(false)
	const [details, setDetails] = React.useState<ReadonlyMap<string, AiSessionDetailsItem>>(() => new Map())
	const filterKeyRef = React.useRef(filterKey)
	const detailsKeyRef = React.useRef(detailsKey)
	const isFetchingRef = React.useRef(false)
	// Sessions whose details have been asked for under the current counted
	// filters — a page is detailed once, not on every render its rows are part
	// of. A request that fails gives its ids back, so the next render retries.
	const detailedRef = React.useRef(new Set<string>())

	React.useEffect(() => {
		filterKeyRef.current = filterKey
		setAdditionalPages({ key: filterKey, pages: NO_PAGES })
		setIsFetchingNextPage(false)
		setPaginationStopped(false)
		isFetchingRef.current = false
	}, [filterKey])

	React.useEffect(() => {
		detailsKeyRef.current = detailsKey
		setDetails(new Map())
		detailedRef.current = new Set()
	}, [detailsKey])

	// The previous filters' pages are still in state for the render a filter
	// change lands on; they are not this filter's rows.
	const pages = additionalPages.key === filterKey ? additionalPages.pages : NO_PAGES

	// The rows as the pages returned them, before their details.
	const pageRows = React.useMemo<ReadonlyArray<AgentSessionRow>>(() => {
		const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
		const additionalData = pages.flatMap((p) => p.data)
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_AI_SESSIONS)
	}, [firstPageResult, pages])

	React.useEffect(() => {
		// A retained result is the previous filters' page, shown dimmed while the
		// new one loads; detailing it would spend the fan-out on rows about to go.
		if (firstPageResult.waiting) return
		const undetailed = pageRows.filter((row) => !detailedRef.current.has(row.sessionId))
		if (undetailed.length === 0) return
		for (const row of undetailed) detailedRef.current.add(row.sessionId)
		const currentKey = detailsKeyRef.current
		// One request per page's worth: the request takes at most a page.
		for (let at = 0; at < undetailed.length; at += AI_SESSION_DETAILS_MAX_SESSIONS) {
			const rows = undetailed.slice(at, at + AI_SESSION_DETAILS_MAX_SESSIONS)
			mapleRuntime
				.runPromise(
					getAiSessionDetails({
						data: {
							// The page's own extent, not the list's window: the rows'
							// bounds are fixed-width warehouse literals, so the string
							// order is the instant order.
							startTime: rows.map((row) => row.startTime).reduce((a, b) => (a < b ? a : b)),
							endTime: rows.map((row) => row.endTime).reduce((a, b) => (a < b ? b : a)),
							sessionIds: rows.map((row) => row.sessionId),
							...countedFilters,
						},
					}),
				)
				.then((result) => {
					if (detailsKeyRef.current !== currentKey) return
					setDetails((prev) => {
						const next = new Map(prev)
						for (const item of result.data) next.set(item.sessionId, item)
						return next
					})
				})
				.catch((error) => {
					if (detailsKeyRef.current !== currentKey) return
					// The rows keep the index's figures; the page is already on screen.
					// The ids go back so the next render that lists them asks again.
					for (const row of rows) detailedRef.current.delete(row.sessionId)
					logClientError("ai_session.details_failed", error)
				})
		}
	}, [pageRows, firstPageResult.waiting, countedFilters])

	const allData = React.useMemo<ReadonlyArray<AgentSessionRow>>(
		() =>
			pageRows.map((row) => {
				const detailed = details.get(row.sessionId)
				if (detailed === undefined) return row
				// The measures the page was ranked and filtered on stay the index's:
				// "Longest" and "Most errors" sort on the agent spans' duration and
				// failures, and the row shows the figure it was sorted by.
				return {
					...row,
					...detailed,
					durationMs: row.durationMs,
					errorSpanCount: row.errorSpanCount,
					hasDetails: true,
				}
			}),
		[pageRows, details],
	)
	const isCapped = allData.length >= MAX_RETAINED_AI_SESSIONS

	// Paged on what the server RANKED, not on the rows it returned: a page can
	// come back a row short of a full one and still not be the last (see
	// `ListAiSessionsResponse.ranked`), so the row count would end the scroll
	// early and the next offset would re-show a session.
	const rankedCount = React.useMemo(() => {
		const first = Result.isSuccess(firstPageResult) ? rankedOf(firstPageResult.value) : 0
		return pages.reduce((sum, page) => sum + page.ranked, first)
	}, [firstPageResult, pages])

	const hasNextPage = React.useMemo(() => {
		if (isCapped) return false
		if (paginationStopped) return false
		if (!Result.isSuccess(firstPageResult)) return false
		if (pages.length === 0) {
			return rankedOf(firstPageResult.value) === PAGE_SIZE
		}
		const lastPage = pages[pages.length - 1]
		return lastPage.ranked === PAGE_SIZE
	}, [firstPageResult, pages, paginationStopped, isCapped])

	const fetchNextPage = React.useCallback(() => {
		if (isFetchingRef.current || !hasNextPage) return
		isFetchingRef.current = true
		setIsFetchingNextPage(true)

		const currentKey = filterKeyRef.current
		const offset = rankedCount

		mapleRuntime
			.runPromise(listAiSessions({ data: { ...filterInputs, limit: PAGE_SIZE, offset } }))
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setAdditionalPages((prev) => ({
					key: currentKey,
					pages: [...(prev.key === currentKey ? prev.pages : NO_PAGES), { data: result.data, ranked: rankedOf(result) }],
				}))
			})
			.catch((error) => {
				if (filterKeyRef.current !== currentKey) return
				// Terminate pagination on failure so the sentinel stops asking;
				// otherwise hasNextPage stays true and the list loops on the error.
				setPaginationStopped(true)
				logClientError("ai_session.pagination_failed", error)
			})
			.finally(() => {
				if (filterKeyRef.current === currentKey) {
					setIsFetchingNextPage(false)
				}
				isFetchingRef.current = false
			})
	}, [filterInputs, rankedCount, hasNextPage])

	return {
		firstPageResult,
		allData,
		isFetchingNextPage,
		hasNextPage,
		isCapped,
		fetchNextPage,
	}
}
