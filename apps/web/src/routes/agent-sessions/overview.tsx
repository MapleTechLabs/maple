import { useMemo, type ReactNode } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { AgentOverviewView } from "@/components/agent-sessions/overview/agent-overview-view"
import { OverviewMetricStripLoading } from "@/components/agent-sessions/overview/overview-metric-strip"
import { OverviewTrendsLoading } from "@/components/agent-sessions/overview/overview-trends"
import { QueryErrorState } from "@/components/common/query-error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NotFoundError } from "@/components/route-error"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { buildAgentOverviewData } from "@/lib/agent-sessions/overview-analytics"
import {
	AGENT_OVERVIEW_DEFAULT_PRESET,
	EMPTY_OVERVIEW_FACETS,
	OverviewSearchFields,
	compareEnabled,
	type AgentOverviewSearch,
	type OverviewFacets,
} from "@/lib/agent-sessions/overview-search"
import { useAgentOverview } from "@/lib/agent-sessions/use-agent-overview"
import { aiSessionsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

const overviewSearchSchema = Schema.Struct({
	...OverviewSearchFields,
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/agent-sessions/overview")({
	component: AgentOverviewPage,
	validateSearch: Schema.toStandardSchemaV1(overviewSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

/**
 * Behind the `agent_tracing` org rollout flag, gated exactly as the list and
 * detail pages are: in the component rather than `beforeLoad` (router context
 * carries no flags), `isLoaded` first so an entitled org gets no not-found
 * flash, and no route `loader` — a loader would fire eleven warehouse reads for
 * orgs that are not entitled to the page at all.
 */
function AgentOverviewPage() {
	const { flags, isLoaded } = useOrganizationFeatureFlags()
	if (!isLoaded) return null
	if (!flags.agentTracing) return <NotFoundError />
	return <AgentOverviewPageContent />
}

function AgentOverviewPageContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? AGENT_OVERVIEW_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	// One object for the whole render tree below: it is a dependency of every
	// selection memo down there, and a fresh literal defeats all of them.
	const window = useMemo(() => ({ startTime, endTime }), [startTime, endTime])

	const onSearchChange = (patch: Partial<AgentOverviewSearch>) => {
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<PageRefreshProvider timePreset={preset}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Agent Sessions", href: "/agent-sessions" }, { label: "Overview" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Scroll className="p-0">
							<AgentOverviewBody
								search={search}
								window={window}
								preset={preset}
								onSearchChange={onSearchChange}
								headerControls={
									<TimeRangeHeaderControls
										startTime={search.startTime ?? startTime}
										endTime={search.endTime ?? endTime}
										presetValue={
											search.timePreset ??
											(search.startTime ? undefined : AGENT_OVERVIEW_DEFAULT_PRESET)
										}
										onTimeChange={handleTimeChange}
									/>
								}
							/>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

/**
 * The eleven reads, resolved.
 *
 * The **summary** is the one the page waits on: it is what the tiles, the chart
 * headlines and the empty state are made of. Everything else degrades to empty
 * rather than to a skeleton, so a slow breakdown leaves an empty table under a
 * strip that is already drawn, not a page of grey boxes.
 */
function AgentOverviewBody({
	search,
	window,
	preset,
	onSearchChange,
	headerControls,
}: {
	search: AgentOverviewSearch
	window: { startTime: string; endTime: string }
	preset: string
	onSearchChange: (patch: Partial<AgentOverviewSearch>) => void
	headerControls: ReactNode
}) {
	const results = useAgentOverview(search, window)
	const windowMs = useMemo(
		() => ({ startMs: toEpochMs(window.startTime), endMs: toEpochMs(window.endTime) }),
		[window.startTime, window.endTime],
	)
	const timeRange = useMemo(
		() => ({
			startTime: search.startTime,
			endTime: search.endTime,
			timePreset: search.timePreset,
		}),
		[search.startTime, search.endTime, search.timePreset],
	)

	// The selects' options come from the sessions facets — the same counted
	// lists the list page's sidebar uses, unfiltered so picking one model does
	// not erase the others. Plain `useAtomValue` keeps them off the Reload
	// subscription, so a manual refresh cannot rebuild a select under a click.
	const facetsResult = useAtomValue(aiSessionsFacetsResultAtom({ data: window }))
	const facets: OverviewFacets = Result.builder(facetsResult)
		.onSuccess((value) => ({
			model: value.models,
			agent: value.agents,
			service: value.services,
			framework: value.vendors,
			environment: value.environments,
			tool: value.tools,
		}))
		.orElse(() => EMPTY_OVERVIEW_FACETS)

	const breakdowns = results.breakdowns.map((breakdown) => ({
		dimension: breakdown.dimension,
		...Result.builder(breakdown.result)
			.onSuccess((value) => ({ entries: value.entries, totalKeys: value.totalKeys }))
			.orElse(() => ({ entries: [], totalKeys: 0 })),
	}))
	const modelMix = Result.builder(results.modelMix)
		.onSuccess((value) => value.rows)
		.orElse(() => [])
	const sessionsOf = (result: (typeof results.topSessions)["cost"]) =>
		Result.builder(result)
			.onSuccess((value) => value.data)
			.orElse(() => [])

	return (
		Result.builder(results.summary)
			// Shaped like what lands, so nothing reflows when it does: the strip keeps
			// its seven tiles and the grid its nine cells.
			.onInitial(() => (
				<div className="flex flex-col">
					<div className="flex flex-col gap-2 px-6 pt-[22px] pb-4">
						<Skeleton className="h-8 w-40" />
						<Skeleton className="h-4 w-full max-w-lg" />
					</div>
					<OverviewMetricStripLoading />
					<OverviewTrendsLoading />
					<div className="flex flex-col gap-2 px-6 py-4">
						<Skeleton className="h-5 w-32" />
						{Array.from({ length: 5 }).map((_, index) => (
							<Skeleton key={index} className="h-[38px] w-full" />
						))}
					</div>
				</div>
			))
			.onError((error) => (
				<QueryErrorState error={error} titleOverride="Failed to load the agent overview" />
			))
			.onSuccess((summary, result) => (
				<AgentOverviewView
					search={search}
					onSearchChange={onSearchChange}
					data={buildAgentOverviewData({
						current: summary.current,
						previous: summary.previous,
						series: summary.series,
						previousSeries: summary.previousSeries,
						modelMix,
						breakdowns,
						// The width the buckets were actually cut at, echoed back rather
						// than re-derived for the axis.
						bucketSeconds: summary.bucketSeconds,
						windowMs,
						windowLabel: preset,
						compare: compareEnabled(search),
					})}
					facets={facets}
					topSessions={{
						cost: sessionsOf(results.topSessions.cost),
						duration: sessionsOf(results.topSessions.duration),
						errored: sessionsOf(results.topSessions.errored),
					}}
					windowLabel={preset}
					timeRange={timeRange}
					headerControls={headerControls}
					waiting={result.waiting}
				/>
			))
			.render()
	)
}
