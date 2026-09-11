import { useMemo, type ReactNode } from "react"

import type { AiToolsSeriesKind } from "@maple/domain/http"

import {
	metricSpark,
	rankSeriesKeys,
	scopeSummary,
	toolSeriesColors,
	type ToolBreakdownRow,
	type ToolSeriesPoint,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"
import {
	selectedMetric,
	selectedPercentile,
	toolDetailLinkSearch,
} from "@/lib/agent-sessions/tool-search"

import { AgentSessionsTabs } from "./agent-sessions-tabs"
import { ToolsTable } from "./tool-breakdown-tables"
import { ToolFilterToolbar, type ToolFilterOption } from "./tool-filter-toolbar"
import { ToolMetricStrip } from "./tool-metric-strip"
import { ToolScopeRow, type ToolScopeChip } from "./tool-scope-row"
import { ToolSeriesChart } from "./tool-series-chart"

export interface AgentToolsViewData {
	/** Split by `seriesKind` — the Tools table's per-row sparks and swatches. */
	readonly series: ReadonlyArray<ToolSeriesPoint>
	/** The whole selection merged inside the query, one point per bucket — what
	 *  the chart and the tiles' sparks draw. */
	readonly scopeSeries: ReadonlyArray<ToolSeriesPoint>
	/** The scope series read's state — the chart says which instead of drawing nothing. */
	readonly seriesLoading?: boolean
	readonly seriesFailure?: unknown
	/** What `seriesKey` names, as the series read reported it — the server derives
	 *  it from the selection, so the chart labels models as models. */
	readonly seriesKind: AiToolsSeriesKind
	readonly totals: ToolTotals
	/** Absent while the comparison window loads, or if it failed — the deltas drop, nothing else does. */
	readonly previousTotals: ToolTotals | undefined
	/** Every session of the window, before the filters — the Sessions tile's denominator. */
	readonly allSessions: number
	/** Calls in the window before the tool/model scope, for the "of M" in the count sentence. */
	readonly scopeCalls: number
	readonly tools: ReadonlyArray<ToolBreakdownRow>
	/** The Tools read's state, so an empty table is only ever a finding. */
	readonly toolsLoading?: boolean
	readonly toolsFailure?: unknown
}

export interface AgentToolsViewProps {
	search: ToolAnalyticsSearch
	/** Applied to the URL by the route. Keys set to `undefined` are cleared. */
	onSearchChange: (patch: Partial<ToolAnalyticsSearch>) => void
	data: AgentToolsViewData
	/** The resolved window in epoch ms — what the table's `new` badge is measured against. */
	window: { startMs: number; endMs: number }
	serviceOptions: ReadonlyArray<ToolFilterOption>
	modelOptions: ReadonlyArray<ToolFilterOption>
	envOptions: ReadonlyArray<ToolFilterOption>
	/** Names the comparison window in the tiles, e.g. "24h". */
	windowLabel: string
	/** The window, carried by the tab strip's link to the Sessions list. */
	timeRange?: TimeRangeSearch
	/** The time-range picker, or whatever the host wants beside the title. */
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
 * locally: the toolbar's predicates are server-side on every read, so the
 * strip, the chart and the table always describe the same population.
 *
 * One column of full-bleed sections divided by hairlines, not a stack of cards:
 * the page is one instrument, and every section is a different reading of the
 * same scope. Reading order is the order the questions get asked: what am I
 * looking at (header, window), over which calls (toolbar), narrowed to what
 * (scope), how much of it (strip), how it moved (chart), and which tool — where
 * a row stops being a comparison and becomes a page of its own.
 */
export function AgentToolsView({
	search,
	onSearchChange,
	data,
	window,
	serviceOptions,
	modelOptions,
	envOptions,
	windowLabel,
	timeRange,
	headerControls,
	waiting,
}: AgentToolsViewProps) {
	const metric = selectedMetric(search)
	const percentile = selectedPercentile(search)

	const chips: ReadonlyArray<ToolScopeChip> = [
		...(search.tool === undefined ? [] : [{ kind: "tool" as const, value: search.tool }]),
		...(search.model === undefined ? [] : [{ kind: "model" as const, value: search.model }]),
	]

	// Per-tool sparks and swatches come out of the series, which only splits by
	// tool while no tool is picked. Once one is, the chart is by model and the
	// table's sparks go quiet rather than showing the same line on every row.
	const seriesIsModels = data.seriesKind === "model"
	const { sparkByTool, colorByTool } = useMemo(() => {
		const byTool = new Map<string, ToolSeriesPoint[]>()
		for (const point of data.series) {
			const bucket = byTool.get(point.seriesKey)
			if (bucket) bucket.push(point)
			else byTool.set(point.seriesKey, [point])
		}
		const sparkByTool = new Map<string, ReadonlyArray<number>>()
		const colorByTool = new Map<string, string>()
		if (!seriesIsModels) {
			// Volume, whatever the chart is drawing: the spark is the row's shape
			// over the window, and a row's shape is how much of it there was.
			for (const [key, points] of byTool) sparkByTool.set(key, metricSpark(points, "calls", percentile))
			for (const [key, token] of toolSeriesColors(rankSeriesKeys(data.series))) {
				colorByTool.set(key, `var(${token})`)
			}
		}
		return { sparkByTool, colorByTool }
	}, [data.series, seriesIsModels, percentile])

	// The ambient scope a row's link carries into the tool's own page — never the
	// tool-name search box, which on a one-tool page filters that tool's name.
	const detailSearch = useMemo(() => toolDetailLinkSearch(search, timeRange), [search, timeRange])

	return (
		<div className="flex flex-col">
			<header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-[22px] pb-4">
				<div className="flex min-w-0 flex-col gap-1.5">
					<h1 className="text-[28px] font-semibold leading-8 tracking-[-0.02em] text-foreground">
						Tools
					</h1>
					<p className="font-mono text-[13px] leading-[18px] text-muted-foreground">
						How every tool your agents call is behaving — volume, latency and failures.
					</p>
				</div>
				{headerControls ? (
					<div className="flex shrink-0 items-center gap-2 pt-1">{headerControls}</div>
				) : null}
			</header>

			<AgentSessionsTabs
				active="tools"
				search={timeRange}
				counts={{ sessions: data.allSessions, tools: data.tools.length }}
				className="border-b border-border px-6"
			/>

			<ToolFilterToolbar
				query={search.q ?? ""}
				onSearch={(value) => onSearchChange({ q: value === "" ? undefined : value })}
				service={search.service}
				serviceOptions={serviceOptions}
				onServiceChange={(value) => onSearchChange({ service: value })}
				model={search.model}
				modelOptions={modelOptions}
				onModelChange={(value) => onSearchChange({ model: value })}
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
				series={data.scopeSeries}
				metric={metric}
				percentile={percentile}
				allSessions={data.allSessions}
				// The default stays out of the URL, so a shared link only carries a
				// metric when one was actually chosen.
				onSelectMetric={(next) => onSearchChange({ metric: next === "calls" ? undefined : next })}
				onSelectPercentile={(next) =>
					onSearchChange({ percentile: next === "p90" ? undefined : next })
				}
				windowLabel={windowLabel}
			/>

			<ToolSeriesChart
				series={data.scopeSeries}
				loading={data.seriesLoading}
				failure={data.seriesFailure}
				metric={metric}
				percentile={percentile}
				tool={search.tool}
				model={search.model}
				modelLabel={(model) => model}
				waiting={waiting}
			/>

			<ToolsTable
				rows={data.tools}
				percentile={percentile}
				window={window}
				detailSearch={detailSearch}
				selected={search.tool}
				sparkFor={(tool) => sparkByTool.get(tool) ?? []}
				colorFor={(tool) => colorByTool.get(tool)}
				loading={data.toolsLoading}
				failure={data.toolsFailure}
				waiting={waiting}
			/>
		</div>
	)
}
