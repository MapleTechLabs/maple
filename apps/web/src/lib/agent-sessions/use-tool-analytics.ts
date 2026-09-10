// Every warehouse read `/agent-sessions/tools` makes, behind one hook.
//
// The page itself never touches an atom: it takes the four `Result`s this
// returns and renders them. That is what lets the lab mount the same page shell
// over fixtures, and it keeps the wire shape confined to the mappers in
// `api/warehouse/ai-session-tools.ts`.

import { useMemo } from "react"

import type { AiToolsSeriesKind } from "@maple/domain/http"

import type { Result } from "@/lib/effect-atom"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	aiToolBreakdownsResultAtom,
	aiToolSeriesResultAtom,
	aiToolSessionsResultAtom,
	aiToolTotalsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { AiToolsSelection } from "@/api/warehouse/ai-session-tools"

import type {
	ToolBreakdownRow,
	ToolSeriesPoint,
	ToolSessionRow,
	ToolTotals,
} from "./tool-analytics"
import type { ToolAnalyticsSearch } from "./tool-search"

/** Sessions listed for the current selection. The endpoint's own cap is 200. */
const SESSIONS_LIMIT = 50

export interface ToolAnalyticsResults {
	readonly series: Result.Result<
		{ data: ReadonlyArray<ToolSeriesPoint>; seriesKind: AiToolsSeriesKind },
		QueryAtomFailure
	>
	/** Both windows in one read — `previous` is what the strip's deltas measure against. */
	readonly totals: Result.Result<{ current: ToolTotals; previous: ToolTotals }, QueryAtomFailure>
	readonly breakdowns: Result.Result<
		{ tools: ReadonlyArray<ToolBreakdownRow>; models: ReadonlyArray<ToolBreakdownRow> },
		QueryAtomFailure
	>
	readonly sessions: Result.Result<{ data: ReadonlyArray<ToolSessionRow> }, QueryAtomFailure>
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

	const series = useRefreshableAtomValue(
		aiToolSeriesResultAtom({ data: { ...selection, bucketSeconds } }),
	)
	const totals = useRefreshableAtomValue(aiToolTotalsResultAtom({ data: selection }))
	const breakdowns = useRefreshableAtomValue(aiToolBreakdownsResultAtom({ data: selection }))
	const sessions = useRefreshableAtomValue(
		aiToolSessionsResultAtom({ data: { ...selection, limit: SESSIONS_LIMIT } }),
	)

	return { series, totals, breakdowns, sessions }
}
