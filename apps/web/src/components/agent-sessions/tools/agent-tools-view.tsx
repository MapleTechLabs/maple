import { useMemo, type ReactNode } from "react"

import type { AiToolsSeriesKind } from "@maple/domain/http"

import { PageHero } from "@/components/infra/primitives/page-hero"
import { useDetectedModels } from "@/hooks/use-detected-models"
import {
	metricSpark,
	scopeSummary,
	type ToolBreakdownRow,
	type ToolSeriesPoint,
	type ToolSessionRow,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"
import { selectedMetric, selectedPercentile } from "@/lib/agent-sessions/tool-search"

import { AgentSessionsTabs } from "./agent-sessions-tabs"
import { ModelsPanel, ToolsTable } from "./tool-breakdown-tables"
import { ToolFilterToolbar, type ToolFilterOption } from "./tool-filter-toolbar"
import { ToolMetricStrip } from "./tool-metric-strip"
import { ToolScopeRow, type ToolScopeChip } from "./tool-scope-row"
import { ToolSeriesChart } from "./tool-series-chart"
import { ToolSessionsPanel } from "./tool-sessions-panel"

export interface AgentToolsViewData {
	readonly series: ReadonlyArray<ToolSeriesPoint>
	/** What `seriesKey` names, as the series read reported it — the server derives
	 *  it from the selection, so the chart labels models as models. */
	readonly seriesKind: AiToolsSeriesKind
	readonly totals: ToolTotals
	/** Absent while the comparison window loads, or if it failed — the deltas drop, nothing else does. */
	readonly previousTotals: ToolTotals | undefined
	/** Calls in the window before the tool/model scope, for the "of M" in the count sentence. */
	readonly scopeCalls: number
	readonly tools: ReadonlyArray<ToolBreakdownRow>
	readonly models: ReadonlyArray<ToolBreakdownRow>
	readonly sessions: ReadonlyArray<ToolSessionRow>
}

export interface AgentToolsViewProps {
	search: ToolAnalyticsSearch
	/** Applied to the URL by the route. Keys set to `undefined` are cleared. */
	onSearchChange: (patch: Partial<ToolAnalyticsSearch>) => void
	data: AgentToolsViewData
	serviceOptions: ReadonlyArray<ToolFilterOption>
	envOptions: ReadonlyArray<ToolFilterOption>
	/** Names the comparison window in the duration tile, e.g. "7d". */
	windowLabel: string
	/** The window, carried by the tab strip's link to the Sessions list. */
	timeRange?: TimeRangeSearch
	/** The time-range picker, or whatever the host wants beside the tabs. */
	headerControls?: ReactNode
	/** Dim the data surfaces while a refetch is in flight. */
	waiting?: boolean
}

/**
 * The whole `/agent-sessions/tools` page below the layout chrome, over data
 * that has already resolved.
 *
 * Presentational on purpose: the route hands it resolved values and the lab
 * hands it fixtures, so the page can be looked at and reviewed without a
 * warehouse behind it — `ai_trace_index` does not exist in the local Tinybird
 * container. Every control here writes a search param and nothing filters rows
 * locally: the toolbar's search and failing-only are server-side predicates on
 * all four reads, so the strip, the chart and the tables always describe the
 * same population.
 *
 * Reading order is the order the questions get asked: what am I looking at
 * (header, window), over which calls (toolbar), narrowed to what (scope), how
 * much of it (strip), how it moved (chart), which tool and model (breakdowns),
 * and finally which session — the one row where an aggregate becomes something
 * that actually happened.
 */
export function AgentToolsView({
	search,
	onSearchChange,
	data,
	serviceOptions,
	envOptions,
	windowLabel,
	timeRange,
	headerControls,
	waiting,
}: AgentToolsViewProps) {
	const metric = selectedMetric(search)
	const percentile = selectedPercentile(search)

	// One detection request for every model the page can name — the panel's rows,
	// the sessions list's column, and the chart's series when those are models —
	// rather than one per surface.
	const seriesIsModels = data.seriesKind === "model"
	const modelIds = useMemo(
		() => [
			...data.models.map((row) => row.key),
			...data.sessions.map((row) => row.model),
			...(seriesIsModels ? data.series.map((point) => point.seriesKey) : []),
		],
		[data.models, data.sessions, data.series, seriesIsModels],
	)
	const detect = useDetectedModels(modelIds)

	// Models are named the way the Models panel names them wherever the chart
	// names one, so the legend and the table never call the same model two
	// different things.
	const modelLabel = useMemo(() => (model: string) => detect(model).displayName, [detect])

	const chips: ReadonlyArray<ToolScopeChip> = [
		...(search.tool === undefined ? [] : [{ kind: "tool" as const, value: search.tool }]),
		...(search.model === undefined ? [] : [{ kind: "model" as const, value: search.model }]),
	]

	// Per-tool sparks come out of the series, which only splits by tool while no
	// tool is picked. Once one is, the chart is by model and the table's sparks
	// go quiet rather than showing the same line on every row.
	const sparkByTool = useMemo(() => {
		const byTool = new Map<string, ToolSeriesPoint[]>()
		for (const point of data.series) {
			const bucket = byTool.get(point.seriesKey)
			if (bucket) bucket.push(point)
			else byTool.set(point.seriesKey, [point])
		}
		const out = new Map<string, ReadonlyArray<number>>()
		for (const [key, points] of byTool) out.set(key, metricSpark(points, metric, percentile))
		return out
	}, [data.series, metric, percentile])

	return (
		<div className="space-y-5">
			<PageHero
				title="Agent tools"
				description="Every tool your agents called in the selected window — how often, how long, and how often it failed."
				meta={<AgentSessionsTabs active="tools" search={timeRange} />}
				actions={headerControls}
			/>

			<ToolFilterToolbar
				query={search.q ?? ""}
				onSearch={(value) => onSearchChange({ q: value === "" ? undefined : value })}
				service={search.service}
				serviceOptions={serviceOptions}
				onServiceChange={(value) => onSearchChange({ service: value })}
				env={search.env}
				envOptions={envOptions}
				onEnvChange={(value) => onSearchChange({ env: value })}
				failingOnly={search.failing === true}
				onToggleFailingOnly={() =>
					onSearchChange({ failing: search.failing === true ? undefined : true })
				}
				waiting={waiting}
			/>

			<ToolScopeRow
				chips={chips}
				summary={scopeSummary(data.totals, data.scopeCalls)}
				onRemove={(chip) => onSearchChange({ [chip.kind]: undefined })}
				onClearAll={() => onSearchChange({ tool: undefined, model: undefined })}
			/>

			<ToolMetricStrip
				totals={data.totals}
				previous={data.previousTotals}
				series={data.series}
				metric={metric}
				percentile={percentile}
				// The default stays out of the URL, so a shared link only carries a
				// metric when one was actually chosen.
				onSelectMetric={(next) => onSearchChange({ metric: next === "calls" ? undefined : next })}
				onSelectPercentile={(next) =>
					onSearchChange({ percentile: next === "p90" ? undefined : next })
				}
				windowLabel={windowLabel}
			/>

			<ToolSeriesChart
				series={data.series}
				metric={metric}
				percentile={percentile}
				tool={search.tool}
				model={search.model}
				seriesKind={data.seriesKind}
				modelLabel={modelLabel}
				waiting={waiting}
			/>

			{/* Tools wider than Models: it is the ranked scan, and its names are long.
			    Models is a comparison between a handful of rows and needs the width
			    of four numbers, not of a list. */}
			<div className="grid items-start gap-4 @min-[1000px]/page:grid-cols-[3fr_2fr]">
				<ToolsTable
					rows={data.tools}
					percentile={percentile}
					selected={search.tool}
					onSelect={(tool) => onSearchChange({ tool })}
					sparkFor={(tool) => sparkByTool.get(tool) ?? []}
					waiting={waiting}
				/>
				<ModelsPanel
					rows={data.models}
					percentile={percentile}
					selected={search.model}
					onSelect={(model) => onSearchChange({ model })}
					detect={detect}
					tool={search.tool}
					waiting={waiting}
				/>
			</div>

			<ToolSessionsPanel rows={data.sessions} tool={search.tool} detect={detect} waiting={waiting} />
		</div>
	)
}
