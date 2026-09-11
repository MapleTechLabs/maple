// Every warehouse read `/agent-sessions/tools` makes, behind one hook — plus
// the tab strip's counts, which the Sessions list reads too.
//
// The page itself never touches an atom: it takes the `Result`s this
// returns and renders them. That is what lets the lab mount the same page shell
// over fixtures, and it keeps the wire shape confined to the mappers in
// `api/warehouse/ai-session-tools.ts`.

import { useMemo } from "react"

import type { AiToolsSeriesKind } from "@maple/domain/http"

import { Result, useAtomValue } from "@/lib/effect-atom"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	aiToolBreakdownsResultAtom,
	aiToolSeriesResultAtom,
	aiToolTotalsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { AiToolsSelection } from "@/api/warehouse/ai-session-tools"

import type { ToolBreakdownRow, ToolSeriesPoint, ToolTotals } from "./tool-analytics"
import type { ToolAnalyticsSearch } from "./tool-search"

export interface ToolAnalyticsResults {
	/** Split by tool (or model) — the Tools table's per-row sparks. */
	readonly series: Result.Result<
		{ data: ReadonlyArray<ToolSeriesPoint>; seriesKind: AiToolsSeriesKind },
		QueryAtomFailure
	>
	/** The same selection merged inside the query (`split: "none"`) — what the
	 *  chart and the tiles draw. Merging `series` here instead would add sessions
	 *  across tools and average their percentiles. */
	readonly scopeSeries: Result.Result<
		{ data: ReadonlyArray<ToolSeriesPoint>; seriesKind: AiToolsSeriesKind },
		QueryAtomFailure
	>
	/** Both windows in one read — `previous` is what the strip's deltas measure
	 *  against — plus the window's whole session population, which is the
	 *  Sessions tile's denominator, and the selection's extent. */
	readonly totals: Result.Result<
		{
			current: ToolTotals
			previous: ToolTotals
			allSessions: number
			firstSeen: number
			lastSeen: number
		},
		QueryAtomFailure
	>
	readonly breakdowns: Result.Result<{ tools: ReadonlyArray<ToolBreakdownRow> }, QueryAtomFailure>
}

export interface ToolAnalyticsWindow {
	readonly startTime: string
	readonly endTime: string
}

/**
 * The search params as the endpoints take them.
 *
 * All six filters are server-side, so every read re-scopes to the toolbar and
 * the strip, the chart and the three tables always describe the same calls.
 * That also puts `q` and `failing` in every atom's cache key, which is what
 * makes a typed character a new read rather than a stale one.
 */
export function toolAnalyticsSelection(
	search: ToolAnalyticsSearch,
	window: ToolAnalyticsWindow,
): AiToolsSelection {
	// A blank box is no filter, not a search for the empty string — which the
	// contract refuses.
	const needle = (search.q ?? "").trim()
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		tool: search.tool,
		model: search.model,
		service: search.service,
		env: search.env,
		search: needle === "" ? undefined : needle,
		failingOnly: search.failing === true ? true : undefined,
	}
}

export function useToolAnalytics(
	search: ToolAnalyticsSearch,
	window: ToolAnalyticsWindow,
): ToolAnalyticsResults {
	const selection = useMemo(() => toolAnalyticsSelection(search, window), [search, window])
	const bucketSeconds = chartBucketSeconds(window.startTime, window.endTime)

	const series = useRefreshableAtomValue(aiToolSeriesResultAtom({ data: { ...selection, bucketSeconds } }))
	const scopeSeries = useRefreshableAtomValue(
		aiToolSeriesResultAtom({ data: { ...selection, bucketSeconds, split: "none" as const } }),
	)
	const totals = useRefreshableAtomValue(aiToolTotalsResultAtom({ data: selection }))
	const breakdowns = useRefreshableAtomValue(aiToolBreakdownsResultAtom({ data: selection }))
	return { series, scopeSeries, totals, breakdowns }
}

/**
 * The tab strip's counts, which both Agent Sessions pages show: the window's
 * sessions (`allSessions`, unscoped server-side) and the tools called in it (the
 * breakdown's rows, so capped at its limit).
 *
 * Read over the bare window rather than a page's selection, so neither page's
 * filters move the numbers and switching tabs never changes them. That is also
 * what makes them cheap: with no filters set this is the exact key the Tools
 * page reads itself, and the Sessions list's rolling week snaps to the same
 * window as the Tools default preset — each page finds the other's reads cached.
 *
 * `undefined` until a read lands, so a tab never shows a 0 it does not mean.
 */
export function useAgentSessionsTabCounts(window: ToolAnalyticsWindow): {
	sessions?: number
	tools?: number
} {
	const { startTime, endTime } = window
	const selection = useMemo(() => toolAnalyticsSelection({}, { startTime, endTime }), [startTime, endTime])
	const totals = useAtomValue(aiToolTotalsResultAtom({ data: selection }))
	const breakdowns = useAtomValue(aiToolBreakdownsResultAtom({ data: selection }))
	return {
		sessions: Result.isSuccess(totals) ? totals.value.allSessions : undefined,
		tools: Result.isSuccess(breakdowns) ? breakdowns.value.tools.length : undefined,
	}
}
