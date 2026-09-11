import { useMemo, useState } from "react"

import { AgentToolsView } from "@/components/agent-sessions/tools/agent-tools-view"
import { ToolDetailView } from "@/components/agent-sessions/tools/tool-detail-view"
import { ToolErrorModal } from "@/components/agent-sessions/tools/tool-error-modal"
import { prepareToolErrors } from "@/components/agent-sessions/tools/tool-errors-table"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import {
	DETAIL_TOOLS,
	buildToolAnalyticsFixture,
	buildToolCells,
	buildToolDetailFixture,
	buildToolErrorDetailFixture,
	toolFixtureFacets,
} from "./agent-tools-fixture"

/**
 * The three tools surfaces without a warehouse behind them.
 *
 * The pages are the real ones — the routes mount these same views — over a week
 * of synthetic tool calls. The URL is stood in for by local state, so every
 * control works: the metric tiles take over the chart, the percentile columns
 * re-key the duration column, the toolbar's selects narrow every reading, and
 * an Errors row opens the modal over its own samples.
 *
 * The detail view opens on the tools whose failures are taken from production
 * shapes: `submit_candidate` (one dominant group, groups that fold array
 * indices), `query_data` (a long tail, and a failure recorded before grouping),
 * `sandbox_exec` (a tool that records nothing about why it failed) and `grep`
 * (no failures at all).
 *
 * It exists because `ai_trace_index` is absent from the local Tinybird
 * container, so the real pages have nothing to draw locally — this is where a
 * layout or selection change gets looked at.
 *
 * The width buttons matter here: the tables drop columns at their own container
 * widths (P50/P95 at 900, errors and sessions at 640, the volume spark at 720),
 * and the detail page's chart grid folds to one column at 900.
 */
const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1400px", value: 1400 },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
] as const

const VIEWS = ["overview", "detail"] as const
type LabView = (typeof VIEWS)[number]
type DetailTool = (typeof DETAIL_TOOLS)[number]

const toggleClass = (active: boolean) =>
	active
		? "rounded border border-border bg-accent px-2 py-1 text-xs"
		: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"

export function AgentToolsLab() {
	// One timestamp for the life of the mount: "3m ago" ticking while you look at
	// a spacing change is noise, and the whole fixture is derived from it.
	const [nowMs] = useState(() => Date.now())
	const cells = useMemo(() => buildToolCells(nowMs), [nowMs])
	const facets = useMemo(() => toolFixtureFacets(cells), [cells])

	// Stands in for the URL. Same shape, same defaults-stay-absent rule.
	const [search, setSearch] = useState<ToolAnalyticsSearch>({})
	const [width, setWidth] = useState<number | null>(null)
	const [view, setView] = useState<LabView>("overview")
	const [detailTool, setDetailTool] = useState<DetailTool>("submit_candidate")
	const [errorsLoading, setErrorsLoading] = useState(false)
	// "Load 25 more" clicks on the open group's samples.
	const [pages, setPages] = useState(1)
	// The fixture is a fixed week: the picker is here for its place at the end of
	// the toolbar, not to re-window the data.
	const [preset, setPreset] = useState("7d")

	// The tab counts over the unfiltered week, as the route reads them — the
	// toolbar's filters narrow the table, never the tabs.
	const tabCounts = useMemo(() => {
		const all = buildToolAnalyticsFixture({}, nowMs, cells)
		return { sessions: all.allSessions, tools: all.tools.length }
	}, [nowMs, cells])

	const overview = useMemo(
		() => buildToolAnalyticsFixture(search, nowMs, cells),
		[search, nowMs, cells],
	)
	const detail = useMemo(
		() => buildToolDetailFixture(detailTool, search, nowMs, cells),
		[detailTool, search, nowMs, cells],
	)
	const prepared = useMemo(() => prepareToolErrors(detail.errors, detail.range), [detail])
	const openIndex = prepared.rows.findIndex((row) => row.fingerprint === search.error)
	const openGroup = prepared.rows[openIndex]
	const errorDetail = useMemo(
		() =>
			openGroup === undefined
				? undefined
				: buildToolErrorDetailFixture(detailTool, openGroup, nowMs, {
						session: search.session,
						variant: search.variant,
						pages,
					}),
		[detailTool, openGroup, nowMs, search.session, search.variant, pages],
	)

	const onSearchChange = (patch: Partial<ToolAnalyticsSearch>) => {
		// A different group, session or variant is a different list of samples.
		if ("error" in patch || "session" in patch || "variant" in patch) setPages(1)
		setSearch((previous) => ({ ...previous, ...patch }))
	}

	return (
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-wrap items-center gap-2">
				{VIEWS.map((option) => (
					<button key={option} type="button" onClick={() => setView(option)} className={toggleClass(view === option)}>
						{option}
					</button>
				))}
				<span className="w-4" />
				{WIDTHS.map((option) => (
					<button
						key={option.label}
						type="button"
						onClick={() => setWidth(option.value)}
						className={toggleClass(width === option.value)}
					>
						{option.label}
					</button>
				))}
				{view === "detail" ? (
					<>
						<span className="w-4" />
						{DETAIL_TOOLS.map((tool) => (
							<button
								key={tool}
								type="button"
								onClick={() => {
									setDetailTool(tool)
									onSearchChange({ error: undefined, session: undefined, variant: undefined })
								}}
								className={toggleClass(detailTool === tool)}
							>
								{tool}
							</button>
						))}
						<button
							type="button"
							onClick={() => setErrorsLoading((loading) => !loading)}
							className={toggleClass(errorsLoading)}
						>
							errors loading
						</button>
					</>
				) : null}
				<span className="ml-2 font-mono text-[11px] text-muted-foreground">
					{JSON.stringify(search)}
				</span>
			</div>

			{/* `@container/page` because the pages' breakpoints are container queries
			    against the layout's content column, which is not mounted here. */}
			<div
				className="@container/page min-w-0 overflow-hidden rounded-lg border border-border"
				style={width === null ? undefined : { width }}
			>
				{view === "overview" ? (
					<AgentToolsView
						search={search}
						onSearchChange={onSearchChange}
						data={overview}
						serviceOptions={facets.services}
						modelOptions={facets.models}
						envOptions={facets.environments}
						windowLabel="7d"
						tabCounts={tabCounts}
						actions={
							<PageRefreshProvider>
								<TimeRangeHeaderControls
									presetValue={preset}
									onTimeChange={(range) => setPreset(range.presetValue ?? preset)}
								/>
							</PageRefreshProvider>
						}
					/>
				) : (
					<ToolDetailView
						tool={detailTool}
						search={search}
						onSearchChange={onSearchChange}
						data={errorsLoading ? { ...detail, errors: [], errorsLoading: true } : detail}
						serviceOptions={facets.services}
						modelOptions={facets.models}
						envOptions={facets.environments}
						modal={
							openGroup === undefined || errorDetail === undefined ? null : (
								<ToolErrorModal
									tool={detailTool}
									group={openGroup}
									position={{ index: openIndex, total: prepared.rows.length }}
									detail={errorDetail.detail}
									samples={{
										occurrences: errorDetail.occurrences,
										loading: false,
										paging: errorDetail.hasMore ? "more" : "end",
										onLoadMore: () => setPages((count) => count + 1),
									}}
									toolFailures={detail.errors.reduce((sum, row) => sum + row.calls, 0)}
									toolCalls={detail.totals.calls}
									range={detail.range}
									session={search.session}
									onSelectSession={(session) => onSearchChange({ session })}
									variant={search.variant}
									onSelectVariant={(variant) => onSearchChange({ variant })}
									onStep={(offset) => {
										const next = prepared.rows[openIndex + offset]
										if (next !== undefined) {
											onSearchChange({ error: next.fingerprint, session: undefined, variant: undefined })
										}
									}}
									onClose={() => onSearchChange({ error: undefined, session: undefined, variant: undefined })}
								/>
							)
						}
					/>
				)}
			</div>
		</div>
	)
}
