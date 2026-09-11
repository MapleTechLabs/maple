import { useMemo, useState, type ReactNode } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toEpochMs } from "@maple/ui/lib/time-format"

import {
	AgentOverviewView,
	type AgentOverviewErrors,
} from "@/components/agent-sessions/overview/agent-overview-view"
import { OverviewMetricStripLoading } from "@/components/agent-sessions/overview/overview-metric-strip"
import { OverviewTrendsLoading } from "@/components/agent-sessions/overview/overview-trends"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NotFoundError } from "@/components/route-error"
import {
	PageRefreshProvider,
	usePageRefreshContext,
} from "@/components/time-range-picker/page-refresh-context"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	type TimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useDetectedModels } from "@/hooks/use-detected-models"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { buildAgentOverviewData } from "@/lib/agent-sessions/overview-analytics"
import {
	AGENT_OVERVIEW_DEFAULT_PRESET,
	EMPTY_OVERVIEW_FACETS,
	OverviewSearchFields,
	compareEnabled,
	overviewWindowLabel,
	type AgentOverviewSearch,
	type OverviewDimension,
	type OverviewFacets,
} from "@/lib/agent-sessions/overview-search"
import {
	useAgentOverview,
	type OverviewTopSessionTab,
} from "@/lib/agent-sessions/use-agent-overview"
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
 * flash, and no route `loader` — a loader would fire nine warehouse reads for
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

/** A read as its section renders it: what it has, and the failure if it will
 *  never have anything. A read still in flight is neither — the section keeps
 *  its empty shape until it lands, and only a failed one is drawn as an error. */
interface SectionRead<A> {
	readonly value: A
	readonly error: unknown
}

function sectionRead<A, B, E>(
	result: Result.Result<A, E>,
	map: (value: A) => B,
	// `NoInfer` so the empty shape reads what the mapper returns rather than
	// narrowing it: `[]` on its own infers `never[]`.
	empty: NoInfer<B>,
): SectionRead<B> {
	return Result.builder(result)
		.onSuccess((value) => ({ value: map(value), error: undefined }))
		.onError((error) => ({ value: empty, error }))
		.orElse(() => ({ value: empty, error: undefined }))
}

/**
 * The nine reads, resolved.
 *
 * The **summary** is the one the page waits on: it is what the tiles, the chart
 * headlines and the empty state are made of. Everything else degrades to empty
 * rather than to a skeleton, so a slow breakdown leaves an empty table under a
 * strip that is already drawn, not a page of grey boxes.
 *
 * A read that FAILED is not that, and is not an empty window either: each one
 * is carried to its own section as an error, and only the summary's takes the
 * body. Sections stay presentational — they receive a value and a failure, not
 * a `Result`.
 */
function AgentOverviewBody({
	search,
	window,
	onSearchChange,
	headerControls,
}: {
	search: AgentOverviewSearch & TimeRangeSearch
	window: { startTime: string; endTime: string }
	onSearchChange: (patch: Partial<AgentOverviewSearch>) => void
	headerControls: ReactNode
}) {
	// The Top sessions tab lives here rather than in the table: it decides which
	// list read runs, and only the open one should.
	const [topSessionTab, setTopSessionTab] = useState<OverviewTopSessionTab>("cost")
	const results = useAgentOverview(search, window, topSessionTab)
	// Every read on the page subscribes to this, so one retry re-runs all nine
	// rather than only the one that failed.
	const { reload } = usePageRefreshContext()
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
	// Read off the resolved window, not off the page's default preset: the
	// resolver hands an absolute range straight back, so the default never
	// named it and "prev 7d" beside a two-hour range would be a fiction.
	const windowLabel = overviewWindowLabel(timeRange, windowMs.endMs - windowMs.startMs)

	// The selects' options come from the sessions facets — the same counted
	// lists the list page's sidebar uses, unfiltered so picking one model does
	// not erase the others. Plain `useAtomValue` keeps them off the Reload
	// subscription, so a manual refresh cannot rebuild a select under a click.
	const facetsResult = useAtomValue(aiSessionsFacetsResultAtom({ data: window }))
	const facetsRead: SectionRead<OverviewFacets> = sectionRead(
		facetsResult,
		(value) => ({
			model: value.models,
			agent: value.agents,
			service: value.services,
			framework: value.vendors,
			environment: value.environments,
			tool: value.tools,
		}),
		EMPTY_OVERVIEW_FACETS,
	)

	const breakdownReads = useMemo(
		() =>
			results.breakdowns.map((breakdown) => ({
				dimension: breakdown.dimension,
				read: sectionRead(
					breakdown.result,
					(value) => ({ entries: value.entries, totalKeys: value.totalKeys }),
					{ entries: [], totalKeys: 0 },
				),
			})),
		[results.breakdowns],
	)
	const breakdowns = useMemo(
		() => breakdownReads.map(({ dimension, read }) => ({ dimension, ...read.value })),
		[breakdownReads],
	)
	const breakdownErrors = useMemo(() => {
		const errors: Partial<Record<OverviewDimension, unknown>> = {}
		for (const { dimension, read } of breakdownReads) {
			if (read.error !== undefined) errors[dimension] = read.error
		}
		return errors
	}, [breakdownReads])
	// Held across renders like the breakdowns above: the board's view model is
	// memoised on these, and a fresh empty array every render rebuilds it.
	const modelMixRead = useMemo(
		() => sectionRead(results.modelMix, (value) => value.rows, []),
		[results.modelMix],
	)
	const modelMix = modelMixRead.value
	const sessionsRead = useMemo(
		() => sectionRead(results.topSessions, (value) => value.data, []),
		[results.topSessions],
	)
	const sessions = sessionsRead.value
	// One detection read for the whole table, exactly as the Sessions list does
	// it — the models a row ran are resolved to their vendor and display name.
	const sessionModels = useMemo(() => sessions.flatMap((session) => session.models), [sessions])
	const detectModel = useDetectedModels(sessionModels)

	// Built once per resolved read rather than once per render: the view model
	// carries `series`, `previousSeries` and `modelMix`, and the trends grid
	// memoises nine plot specs and a shared axis on their identity.
	const resolved = Result.isSuccess(results.summary) ? results.summary : undefined
	const summary = resolved?.value
	const compare = compareEnabled(search)
	const data = useMemo(
		() =>
			summary === undefined
				? undefined
				: buildAgentOverviewData({
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
						windowLabel,
						compare,
					}),
		[summary, modelMix, breakdowns, windowMs, windowLabel, compare],
	)

	const summaryError = Result.builder(results.summary)
		.onError((error) => error)
		.orElse(() => undefined)

	// Shaped like what lands, so nothing reflows when it does: the strip keeps
	// its seven tiles and the grid its nine cells. Only while the summary is
	// still in flight — a failed one keeps the page's chrome instead.
	if (data === undefined && summaryError === undefined) {
		return (
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
		)
	}

	const errors: AgentOverviewErrors = {
		summary: summaryError,
		facets: facetsRead.error !== undefined,
		breakdowns: breakdownErrors,
		modelMix: modelMixRead.error,
		topSessions: sessionsRead.error,
	}

	return (
		<AgentOverviewView
			search={search}
			onSearchChange={onSearchChange}
			data={data}
			errors={errors}
			onRetry={reload}
			facets={facetsRead.value}
			topSessions={sessions}
			topSessionTab={topSessionTab}
			onTopSessionTabChange={setTopSessionTab}
			detectModel={detectModel}
			windowLabel={windowLabel}
			timeRange={timeRange}
			headerControls={headerControls}
			waiting={resolved?.waiting}
		/>
	)
}
