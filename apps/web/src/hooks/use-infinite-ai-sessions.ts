import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { AI_SESSION_DETAILS_MAX_SESSIONS, type AiSessionDetailsItem } from "@maple/domain/http"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"

import { getAiSessionDetails, listAiSessions, type ListAiSessionsInput } from "@/api/warehouse/ai-sessions"
import { listAiSessionsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { logClientError } from "@/lib/services/common/telemetry"
import { mapleRuntime } from "@/lib/registry"

export const AI_SESSIONS_PAGE_SIZE = 50
const PAGE_SIZE = AI_SESSIONS_PAGE_SIZE
export const MAX_RETAINED_AI_SESSIONS = 500
export const AI_SESSIONS_LIVE_POLL_MS = 5_000
/**
 * How far before the list's end the live poll reads. The page measures a
 * session — its start and every figure — over the spans inside the window it
 * is given, so a session already running when the list was read would come
 * back from a window starting at the list's end looking new, with only its
 * later spans counted. Read from an hour earlier, such a session starts before
 * the list's end and is dropped; one idle for longer than that still slips
 * through, the gap the list has at its own window's start.
 */
const LIVE_POLL_LOOKBACK_MS = 60 * 60 * 1000

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

/** Sessions the live poll found that started after the list's window, newest
 *  first — tagged like `AdditionalPages`, and for the same reason. */
interface LiveRows {
	key: string
	rows: ReadonlyArray<AgentSessionRow>
}

const NO_PAGES: ReadonlyArray<AiSessionsPage> = []
const NO_ROWS: ReadonlyArray<AgentSessionRow> = []

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
 *
 * Newest first, the list also grows at the top: while the tab is visible, a
 * poll every few seconds reads the sessions that started since the window's
 * end and prepends the ones it has not seen. They are not ranked by any page,
 * so paging never counts them. A row already shown is not refreshed.
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
	const [liveRows, setLiveRows] = React.useState<LiveRows>({ key: filterKey, rows: NO_ROWS })
	const [isFetchingNextPage, setIsFetchingNextPage] = React.useState(false)
	const [paginationStopped, setPaginationStopped] = React.useState(false)
	const [details, setDetails] = React.useState<ReadonlyMap<string, AiSessionDetailsItem>>(() => new Map())
	const filterKeyRef = React.useRef(filterKey)
	const detailsKeyRef = React.useRef(detailsKey)
	const isFetchingRef = React.useRef(false)
	// Not reset on a filter change: a poll still out for the previous filters
	// holds the next one back until it settles, rather than running beside it.
	const isPollingRef = React.useRef(false)
	// Sessions whose details have been asked for under the current counted
	// filters — a page is detailed once, not on every render its rows are part
	// of. A request that fails gives its ids back, so the next render retries.
	const detailedRef = React.useRef(new Set<string>())

	React.useEffect(() => {
		filterKeyRef.current = filterKey
		setAdditionalPages({ key: filterKey, pages: NO_PAGES })
		setLiveRows({ key: filterKey, rows: NO_ROWS })
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
	const live = liveRows.key === filterKey ? liveRows.rows : NO_ROWS

	// The rows as the pages returned them, before their details.
	const pageRows = React.useMemo<ReadonlyArray<AgentSessionRow>>(() => {
		const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
		const paged = [...firstPageData, ...pages.flatMap((p) => p.data)]
		// A page read after the poll can hold a session the poll found first; the
		// page's copy is the one measured over the list's window.
		const pagedIds = new Set(paged.map((row) => row.sessionId))
		return [...live.filter((row) => !pagedIds.has(row.sessionId)), ...paged].slice(0, MAX_RETAINED_AI_SESSIONS)
	}, [firstPageResult, pages, live])

	// Prepending is only right for the order new sessions sort first in, and a
	// retained or failed first page has no window of its own to poll past.
	const livePollEnabled =
		Result.isSuccess(firstPageResult) &&
		!firstPageResult.waiting &&
		(filterInputs.sortBy ?? "startTime") === "startTime" &&
		(filterInputs.sortDir ?? "desc") === "desc"

	const pollLive = React.useEffectEvent(() => {
		if (!livePollEnabled || document.visibilityState !== "visible" || isPollingRef.current) return
		isPollingRef.current = true
		const currentKey = filterKey
		const listEnd = filterInputs.endTime
		mapleRuntime
			.runPromise(
				listAiSessions({
					data: {
						...filterInputs,
						startTime: formatWarehouseDateTime(parseWarehouseDateTime(listEnd) - LIVE_POLL_LOOKBACK_MS),
						endTime: formatWarehouseDateTime(Date.now()),
						limit: PAGE_SIZE,
						offset: 0,
					},
				}),
			)
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setLiveRows((prev) => {
					const known = new Set(prev.rows.map((row) => row.sessionId))
					// Started after the list's end, so every span was in the poll's
					// window. A row's start is a fixed-width warehouse literal and the
					// end its second-precision prefix, so the string order is the
					// instant order.
					const added = result.data.filter((row) => row.startTime > listEnd && !known.has(row.sessionId))
					if (added.length === 0) return prev
					return { key: currentKey, rows: [...added, ...prev.rows].slice(0, MAX_RETAINED_AI_SESSIONS) }
				})
			})
			// The list is still the list; the next tick asks again.
			.catch((error) => logClientError("ai_session.live_poll_failed", error))
			.finally(() => {
				isPollingRef.current = false
			})
	})

	useMountEffect(() => {
		// react-doctor-disable-next-line react-doctor/rules-of-hooks -- React Doctor does not recognize useMountEffect as an Effect Event boundary.
		const poll = () => pollLive()
		const interval = setInterval(poll, AI_SESSIONS_LIVE_POLL_MS)
		// A tab coming back catches up at once rather than on the next tick.
		document.addEventListener("visibilitychange", poll)
		return () => {
			clearInterval(interval)
			document.removeEventListener("visibilitychange", poll)
		}
	})

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
