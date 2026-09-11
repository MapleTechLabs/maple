import { useMemo, type ReactNode } from "react"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { SquareSparkleIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { AgentSessionsTabs } from "@/components/agent-sessions/tools/agent-sessions-tabs"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import type { DetectedModel } from "@/hooks/use-detected-models"
import {
	overviewScopeSummary,
	type AgentOverviewData,
	type OverviewMover,
} from "@/lib/agent-sessions/overview-analytics"
import { bucketWidthLabel } from "@/lib/agent-sessions/overview-buckets"
import {
	activeOverviewFilters,
	clearOverviewFilters,
	compareEnabled,
	sessionsLinkSearch,
	toggleOverviewFilter,
	type AgentOverviewSearch,
	type OverviewDimension,
	type OverviewFacets,
} from "@/lib/agent-sessions/overview-search"
import type { OverviewTopSessionTab } from "@/lib/agent-sessions/use-agent-overview"

import { OverviewBreakdowns } from "./overview-breakdowns"
import { OverviewFilterToolbar } from "./overview-filter-toolbar"
import { OverviewMetricStrip } from "./overview-metric-strip"
import { OverviewMoversRail } from "./overview-movers-rail"
import { OverviewScopeRow } from "./overview-scope-row"
import { OverviewTopSessions } from "./overview-top-sessions"
import { OverviewTrends } from "./overview-trends"

/**
 * The failures the page draws rather than swallows, one per read.
 *
 * A section that failed says so where its own numbers would have been, because
 * an empty table and a table that could not be read are different facts about
 * the window. Only the summary's failure takes the body: everything in it — the
 * tiles, the nine headlines, the empty state — is made of that one read.
 *
 * `facets` is a flag and not an error: the selects lose their options and
 * nothing else, so the toolbar says so in a line.
 */
export interface AgentOverviewErrors {
	readonly summary?: unknown
	readonly facets?: boolean
	readonly breakdowns?: Partial<Record<OverviewDimension, unknown>>
	readonly modelMix?: unknown
	readonly topSessions?: unknown
}

export interface AgentOverviewViewProps {
	search: AgentOverviewSearch
	/** Applied to the URL by the route. Keys set to `undefined` are cleared. */
	onSearchChange: (patch: Partial<AgentOverviewSearch>) => void
	/** Absent only when the summary read failed; the host renders its own
	 *  skeleton while that read is in flight. */
	data?: AgentOverviewData
	errors?: AgentOverviewErrors
	/** Re-runs every read on the page — what a failed summary offers. */
	onRetry?: () => void
	facets: OverviewFacets
	/** The active top-sessions tab's rows, and the tab itself — it lives with
	 *  whoever issues that read rather than inside the table. */
	topSessions: ReadonlyArray<AgentSessionRow>
	topSessionTab: OverviewTopSessionTab
	onTopSessionTabChange: (tab: OverviewTopSessionTab) => void
	/** Resolves a model to its vendor and display name; a warehouse read, so the
	 *  page's owner does it and this tree stays presentational. */
	detectModel?: (model: string) => DetectedModel
	/** Names the window and its comparison in the tiles, e.g. `7d`. */
	windowLabel: string
	/** The window, carried by the tab strip's link to the Sessions list. */
	timeRange?: TimeRangeSearch
	/** The time-range picker, or whatever the host wants beside the title. */
	headerControls?: ReactNode
	/** Dim the data surfaces while a refetch is in flight. */
	waiting?: boolean
}

/**
 * The whole `/agent-sessions/overview` page below the layout chrome, over data
 * that has already resolved.
 *
 * Presentational on purpose: the route hands it resolved values and the lab
 * hands it fixtures, so the page can be looked at and reviewed without a
 * warehouse behind it — `ai_trace_index` does not exist in the local Tinybird
 * container. Every control writes a search param and nothing filters rows
 * locally: the toolbar's predicates are server-side on every read, so the
 * tiles, the grid and the tables always describe the same sessions.
 *
 * One column of full-bleed sections divided by hairlines, not a stack of cards:
 * the page is one instrument, and every section is a different reading of the
 * same scope. Reading order is the order the questions get asked: what am I
 * looking at, over which sessions, narrowed to what, how much of it, how it
 * moved and what moved most, grouped how, and finally which sessions.
 */
export function AgentOverviewView({
	search,
	onSearchChange,
	data,
	errors,
	onRetry,
	facets,
	topSessions,
	topSessionTab,
	onTopSessionTabChange,
	detectModel,
	windowLabel,
	timeRange,
	headerControls,
	waiting,
}: AgentOverviewViewProps) {
	const chips = useMemo(() => activeOverviewFilters(search), [search])
	const selectDimension = (dimension: OverviewDimension, key: string) =>
		onSearchChange(toggleOverviewFilter(search, dimension, key))

	const note =
		data === undefined
			? ""
			: [
					compareEnabled(search) ? `previous ${windowLabel}` : `last ${windowLabel}`,
					`${bucketWidthLabel(data.bucketSeconds)} buckets`,
				].join(" · ")

	return (
		<div className="flex flex-col">
			<header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-[22px] pb-4">
				<div className="flex min-w-0 flex-col gap-1.5">
					<h1 className="text-[28px] font-semibold leading-8 tracking-[-0.02em] text-foreground">
						Overview
					</h1>
					<p className="font-mono text-[13px] leading-[18px] text-muted-foreground">
						Volume, cost, tokens, reliability and latency for every agent session — all on one
						clock.
					</p>
				</div>
				{headerControls ? (
					<div className="flex shrink-0 items-center gap-2 pt-1">{headerControls}</div>
				) : null}
			</header>

			<AgentSessionsTabs active="overview" search={timeRange} className="border-b border-border px-6" />

			<OverviewFilterToolbar
				search={search}
				facets={facets}
				onSearchChange={onSearchChange}
				windowLabel={windowLabel}
				facetsUnavailable={errors?.facets}
				waiting={waiting}
			/>

			{/* The whole board is the summary's, so its failure takes the body —
			    under the chrome, which is what the window and the scope are changed
			    from and is the only way back from here without leaving the page. */}
			{data === undefined ? (
				<div className="p-6">
					<QueryErrorState
						error={errors?.summary}
						titleOverride="Failed to load the agent overview"
						onRetry={onRetry}
					/>
				</div>
			) : (
				<>
					{/* The chips stay up when the scope matches nothing: a reader looking
					    at an empty board needs to see what emptied it. */}
					<OverviewScopeRow
						chips={chips}
						summary={overviewScopeSummary(data.current)}
						onRemove={(chip) => selectDimension(chip.dimension, chip.value)}
						onClearAll={() => onSearchChange(clearOverviewFilters())}
					/>

					{data.current.sessions === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<SquareSparkleIcon />
								</EmptyMedia>
								<EmptyTitle>No agent sessions in this range</EmptyTitle>
								<EmptyDescription>
									{chips.length === 0
										? "Nothing your agents ran was recorded in this window. Widen the range, or check that the SDK is reporting."
										: "Nothing in this window matches the scope above. Remove a filter to widen it."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<>
							<OverviewMetricStrip tiles={data.tiles} waiting={waiting} />

							<OverviewTrends
								charts={data.charts}
								series={data.series}
								previousSeries={data.previousSeries}
								modelMix={data.modelMix}
								modelMixError={errors?.modelMix}
								note={note}
								waiting={waiting}
								rail={
									<OverviewMoversRail
										movers={data.movers}
										coverage={data.coverage}
										compare={data.compare}
										windowLabel={windowLabel}
										onSelect={(mover: OverviewMover) =>
											selectDimension(mover.dimension, mover.key)
										}
									/>
								}
							/>

							<OverviewBreakdowns
								breakdowns={data.breakdowns}
								modelMix={data.modelMix}
								search={search}
								onSelectRow={selectDimension}
								errors={errors?.breakdowns}
								waiting={waiting}
							/>

							<OverviewTopSessions
								sessions={topSessions}
								active={topSessionTab}
								onActiveChange={onTopSessionTabChange}
								erroredCount={data.current.erroredSessions}
								sessionsSearch={sessionsLinkSearch(search)}
								detectModel={detectModel}
								error={errors?.topSessions}
								waiting={waiting}
							/>
						</>
					)}
				</>
			)}
		</div>
	)
}
