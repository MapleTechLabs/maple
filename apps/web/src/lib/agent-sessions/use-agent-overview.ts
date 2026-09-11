// Every warehouse read `/agent-sessions/overview` makes, behind one hook.
//
// The page itself never touches an atom: it takes the `Result`s this returns
// and renders them. That is what lets the lab mount the same view over
// fixtures, and it keeps the wire shape confined to the mappers in
// `api/warehouse/ai-agent-overview.ts`.
//
// Nine reads, because the board is nine questions: the summary, one breakdown
// per dimension (those tabs are component state and the movers rail reads all
// six anyway), the model mix, and ONE page of six sessions — the Top sessions
// tab the reader is actually on. The other two are read when they are opened,
// and the atom family holds them from then on.

import { useMemo } from "react"

import type { Effect } from "effect"
import type { AiSessionSortKey } from "@maple/domain/http"

import type {
	AiOverviewBreakdownData,
	AiOverviewModelMixData,
	AiOverviewSelection,
	AiOverviewSummaryData,
} from "@/api/warehouse/ai-agent-overview"
import type { ListAiSessionsInput, listAiSessions } from "@/api/warehouse/ai-sessions"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { Result } from "@/lib/effect-atom"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import {
	aiOverviewBreakdownResultAtom,
	aiOverviewModelMixResultAtom,
	aiOverviewSummaryResultAtom,
	listAiSessionsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

import { smallMultipleBucketSeconds } from "./overview-buckets"
import { overviewApiDimension, type AgentOverviewSearch, type OverviewDimension } from "./overview-search"

export interface AgentOverviewWindow {
	readonly startTime: string
	readonly endTime: string
}

/** Enough rows to recognise a pattern, few enough to read without scrolling. */
export const OVERVIEW_TOP_SESSIONS_LIMIT = 6

/** The three readings of "show me the sessions behind this". */
export const OVERVIEW_TOP_SESSION_TABS = ["cost", "duration", "errored"] as const
export type OverviewTopSessionTab = (typeof OVERVIEW_TOP_SESSION_TABS)[number]

/** How each tab asks the list for its six rows. */
const TOP_SESSION_READS = {
	cost: { sortBy: "cost" },
	duration: { sortBy: "durationMs" },
	errored: { sortBy: "errorSpanCount", hasErrors: true },
} satisfies Record<OverviewTopSessionTab, { sortBy: AiSessionSortKey; hasErrors?: boolean }>

/** The list read's own page shape — the rows the Top sessions table renders. */
export type AgentOverviewSessionsPage = Effect.Success<ReturnType<typeof listAiSessions>>
type SessionsResult = Result.Result<AgentOverviewSessionsPage, QueryAtomFailure>

export interface AgentOverviewResults {
	readonly summary: Result.Result<AiOverviewSummaryData, QueryAtomFailure>
	/** In `OVERVIEW_DIMENSIONS` order. */
	readonly breakdowns: ReadonlyArray<{
		readonly dimension: OverviewDimension
		readonly result: Result.Result<AiOverviewBreakdownData, QueryAtomFailure>
	}>
	readonly modelMix: Result.Result<AiOverviewModelMixData, QueryAtomFailure>
	/** The active tab's page. The tab is the caller's state, so switching it is
	 *  what issues the other reads. */
	readonly topSessions: SessionsResult
}

/**
 * The search params as the three overview endpoints take them.
 *
 * All six filters are server-side, so every read re-scopes to the toolbar and
 * the tiles, the grid and the tables always describe the same sessions. That
 * also puts every filter in every atom's cache key, which is what makes a
 * chosen model a new read rather than a stale one.
 */
export function overviewSelection(
	search: AgentOverviewSearch,
	window: AgentOverviewWindow,
): AiOverviewSelection {
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		framework: search.framework,
		model: search.model,
		agent: search.agent,
		service: search.service,
		environment: search.environment,
		tool: search.tool,
		hasErrors: search.hasErrors === true ? true : undefined,
	}
}

/**
 * One page of the sessions list, under the board's own scope.
 *
 * The list is the concrete end of every number above it, so it must filter by
 * exactly the same six dimensions — under the array-valued names the list
 * endpoint uses.
 */
export function overviewSessionsInput(
	search: AgentOverviewSearch,
	window: AgentOverviewWindow,
	options: { sortBy: AiSessionSortKey; hasErrors?: boolean },
): ListAiSessionsInput {
	const one = (value: string | undefined) => (value === undefined ? undefined : [value])
	const errors = options.hasErrors ?? search.hasErrors === true
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		vendorIds: one(search.framework),
		serviceNames: one(search.service),
		deploymentEnvs: one(search.environment),
		models: one(search.model),
		agentNames: one(search.agent),
		toolNames: one(search.tool),
		hasErrors: errors ? true : undefined,
		sortBy: options.sortBy,
		sortDir: "desc",
		limit: OVERVIEW_TOP_SESSIONS_LIMIT,
	}
}

export function useAgentOverview(
	search: AgentOverviewSearch,
	window: AgentOverviewWindow,
	topSessionTab: OverviewTopSessionTab,
): AgentOverviewResults {
	const selection = useMemo(() => overviewSelection(search, window), [search, window])
	// The grid is nine ~104px-tall plots rather than one wide chart, so the
	// buckets are cut at a width that reads at that size.
	const bucketSeconds = smallMultipleBucketSeconds(window.startTime, window.endTime)
	const bucketed = { ...selection, bucketSeconds }

	const summary = useRefreshableAtomValue(aiOverviewSummaryResultAtom({ data: bucketed }))
	const modelMix = useRefreshableAtomValue(aiOverviewModelMixResultAtom({ data: bucketed }))

	// One call per dimension, written out: a loop over the dimensions would be a
	// hook in a loop.
	const model = useRefreshableAtomValue(
		aiOverviewBreakdownResultAtom({ data: { ...selection, dimension: "model" } }),
	)
	const agent = useRefreshableAtomValue(
		aiOverviewBreakdownResultAtom({ data: { ...selection, dimension: "agent" } }),
	)
	const service = useRefreshableAtomValue(
		aiOverviewBreakdownResultAtom({ data: { ...selection, dimension: "service" } }),
	)
	const framework = useRefreshableAtomValue(
		aiOverviewBreakdownResultAtom({
			data: { ...selection, dimension: overviewApiDimension("framework") },
		}),
	)
	const environment = useRefreshableAtomValue(
		aiOverviewBreakdownResultAtom({ data: { ...selection, dimension: "environment" } }),
	)
	const tool = useRefreshableAtomValue(
		aiOverviewBreakdownResultAtom({ data: { ...selection, dimension: "tool" } }),
	)

	const topSessions = useRefreshableAtomValue(
		listAiSessionsResultAtom({
			data: overviewSessionsInput(search, window, TOP_SESSION_READS[topSessionTab]),
		}),
	)

	// Held across renders: the page builds its whole view model from these, and
	// a fresh array of the same six results every render would rebuild it —
	// along with every chart memo keyed on the series it produces.
	return useMemo<AgentOverviewResults>(
		() => ({
			summary,
			modelMix,
			breakdowns: [
				{ dimension: "model", result: model },
				{ dimension: "agent", result: agent },
				{ dimension: "service", result: service },
				{ dimension: "framework", result: framework },
				{ dimension: "environment", result: environment },
				{ dimension: "tool", result: tool },
			],
			topSessions,
		}),
		[summary, modelMix, model, agent, service, framework, environment, tool, topSessions],
	)
}
