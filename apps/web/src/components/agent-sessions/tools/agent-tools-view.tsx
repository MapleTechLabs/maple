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
	serviceOptions: ReadonlyArray<ToolFilterOption>
	modelOptions: ReadonlyArray<ToolFilterOption>
	envOptions: ReadonlyArray<ToolFilterOption>
	/** Names the comparison window in the tiles, e.g. "24h". */
	windowLabel: string
	/** The window, carried by the tab strip's link to the Sessions list. */
	timeRange?: TimeRangeSearch
	/** The tab strip's counts — see `useAgentSessionsTabCounts`. A count left out is not shown. */
	tabCounts?: { sessions?: number; tools?: number }
	/** The time-range picker and Reload, at the right end of the toolbar. */
	actions?: ReactNode
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
 * same scope. Reading order is the order the questions get asked: which view
 * (tabs), over which calls and window (toolbar), narrowed to what
 * (scope), how much of it (strip), how it moved (chart), and which tool — where
 * a row stops being a comparison and becomes a page of its own.
 *
 * No title: the tab strip names the page. The strip and the toolbar sit at the
 * same height as on the Sessions list, so switching tabs moves neither.
 */
export function AgentToolsView({
	search,
	onSearchChange,
	data,
	serviceOptions,
	modelOptions,
	envOptions,
	windowLabel,
	timeRange,
	tabCounts,
	actions,
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

	// `pt-4` is the Sessions list's sticky padding, and the strip's hairline and
	// the toolbar's `py-3` are matched there too: one height on both tabs.
	return (
		<div className="flex flex-col pt-4">
			<AgentSessionsTabs
				active="tools"
				search={timeRange}
				counts={tabCounts}
				className="border-b border-border px-6"
			/>

			<ToolFilterToolbar
				nameSearch={{
					query: search.q ?? "",
					onSearch: (value) => onSearchChange({ q: value === "" ? undefined : value }),
				}}
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
				actions={actions}
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
