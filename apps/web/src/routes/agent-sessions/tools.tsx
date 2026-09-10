import type { ReactNode } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { AgentToolsView } from "@/components/agent-sessions/tools/agent-tools-view"
import type { ToolFilterOption } from "@/components/agent-sessions/tools/tool-filter-toolbar"
import { ToolMetricStripLoading } from "@/components/agent-sessions/tools/tool-metric-strip"
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
import {
	TOOL_ANALYTICS_DEFAULT_PRESET,
	ToolAnalyticsSearchFields,
	type ToolAnalyticsSearch,
} from "@/lib/agent-sessions/tool-search"
import { useToolAnalytics } from "@/lib/agent-sessions/use-tool-analytics"
import { aiSessionsFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

const toolsSearchSchema = Schema.Struct({
	...ToolAnalyticsSearchFields,
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/agent-sessions/tools")({
	component: AgentToolsPage,
	validateSearch: Schema.toStandardSchemaV1(toolsSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

/**
 * Behind the `agent_tracing` org rollout flag, gated exactly as the list and
 * detail pages are: in the component rather than `beforeLoad` (router context
 * carries no flags), `isLoaded` first so an entitled org gets no not-found
 * flash, and no route `loader` — a loader would fire six warehouse reads for
 * orgs that are not entitled to the page at all.
 */
function AgentToolsPage() {
	const { flags, isLoaded } = useOrganizationFeatureFlags()
	if (!isLoaded) return null
	if (!flags.agentTracing) return <NotFoundError />
	return <AgentToolsPageContent />
}

function AgentToolsPageContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? TOOL_ANALYTICS_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)

	const onSearchChange = (patch: Partial<ToolAnalyticsSearch>) => {
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
					items={[{ label: "Agent Sessions", href: "/agent-sessions" }, { label: "Tools" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Scroll>
							<AgentToolsBody
								search={search}
								window={{ startTime, endTime }}
								preset={preset}
								onSearchChange={onSearchChange}
								headerControls={
									<TimeRangeHeaderControls
										startTime={search.startTime ?? startTime}
										endTime={search.endTime ?? endTime}
										presetValue={
											search.timePreset ??
											(search.startTime ? undefined : TOOL_ANALYTICS_DEFAULT_PRESET)
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
 * The four reads, resolved.
 *
 * The **totals** read is the one the page waits on: it is the smallest of the
 * four and it is what the strip — the page's selector — is made of. Everything
 * else degrades to empty rather than to a skeleton, so a slow breakdown query
 * leaves an empty table under a chart that is already drawn, not a page of grey
 * boxes.
 */
function AgentToolsBody({
	search,
	window,
	preset,
	onSearchChange,
	headerControls,
}: {
	search: ToolAnalyticsSearch
	window: { startTime: string; endTime: string }
	preset: string
	onSearchChange: (patch: Partial<ToolAnalyticsSearch>) => void
	headerControls: ReactNode
}) {
	const results = useToolAnalytics(search, window)

	// Service and environment options come from the sessions facets — the same
	// counted lists the list page's sidebar uses. A dedicated facets endpoint for
	// this page would be a second query returning the same two arrays.
	// Plain `useAtomValue`: the options refresh when the window rolls, which is
	// enough, and keeping them off the Reload subscription stops a manual refresh
	// from rebuilding the two selects underneath a click.
	const facetsResult = useAtomValue(aiSessionsFacetsResultAtom({ data: window }))
	const facets = Result.builder(facetsResult)
		.onSuccess((value) => value)
		.orElse(() => undefined)
	const serviceOptions: ReadonlyArray<ToolFilterOption> = facets?.services ?? []
	const envOptions: ReadonlyArray<ToolFilterOption> = facets?.environments ?? []

	const breakdowns = Result.builder(results.breakdowns)
		.onSuccess((value) => value)
		.orElse(() => ({ tools: [], models: [] }))
	// `seriesKind` is the server's, derived from the same selection the query
	// keyed on — the chart labels models as models without re-deriving it.
	const series = Result.builder(results.series)
		.onSuccess((value) => value)
		.orElse(() => ({ data: [], seriesKind: "tool" }) as const)
	const sessions = Result.builder(results.sessions)
		.onSuccess((value) => value.data)
		.orElse(() => [])

	return Result.builder(results.totals)
		.onInitial(() => (
			<div className="space-y-5">
				<Skeleton className="h-16 w-full max-w-2xl" />
				<ToolMetricStripLoading />
				<Skeleton className="h-56 w-full" />
				<Skeleton className="h-80 w-full" />
			</div>
		))
		.onError((error) => (
			<QueryErrorState error={error} titleOverride="Failed to load agent tool analytics" />
		))
		.onSuccess((totals, result) => (
			<AgentToolsView
				search={search}
				onSearchChange={onSearchChange}
				data={{
					series: series.data,
					seriesKind: series.seriesKind,
					totals: totals.current,
					previousTotals: totals.previous,
					// The "of M" denominator: the Tools breakdown is scoped to the
					// selected model but NOT to the selected tool, so its sum is exactly
					// the population the tool chip narrows. Zero while that read is in
					// flight, which `scopeSummary` renders as "nothing narrowed" rather
					// than as a wrong ratio.
					scopeCalls: breakdowns.tools.reduce((sum, row) => sum + row.calls, 0),
					tools: breakdowns.tools,
					models: breakdowns.models,
					sessions,
				}}
				serviceOptions={serviceOptions}
				envOptions={envOptions}
				windowLabel={preset}
				timeRange={{
					startTime: search.startTime,
					endTime: search.endTime,
					timePreset: search.timePreset,
				}}
				headerControls={headerControls}
				waiting={result.waiting}
			/>
		))
		.render()
}
