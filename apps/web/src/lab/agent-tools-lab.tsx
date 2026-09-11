import { useMemo, useState } from "react"

import { AgentToolsView } from "@/components/agent-sessions/tools/agent-tools-view"
import { ToolDetailView } from "@/components/agent-sessions/tools/tool-detail-view"
import { ToolErrorModal } from "@/components/agent-sessions/tools/tool-error-modal"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import {
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
 * an Errors row opens the modal over its own occurrences.
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

/** The tool the detail view opens on — the one the fixture regresses. */
const DETAIL_TOOL = "run_tests"

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

	const overview = useMemo(
		() => buildToolAnalyticsFixture(search, nowMs, cells),
		[search, nowMs, cells],
	)
	const detail = useMemo(
		() => buildToolDetailFixture(DETAIL_TOOL, search, nowMs, cells),
		[search, nowMs, cells],
	)
	const errorDetail = useMemo(
		() =>
			search.error === undefined
				? undefined
				: buildToolErrorDetailFixture(DETAIL_TOOL, search.error, detail.errors, nowMs),
		[search.error, detail.errors, nowMs],
	)
	const openError = detail.errors.find((row) => row.errorType === search.error)

	const onSearchChange = (patch: Partial<ToolAnalyticsSearch>) =>
		setSearch((previous) => ({ ...previous, ...patch }))

	return (
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-wrap items-center gap-2">
				{VIEWS.map((option) => (
					<button
						key={option}
						type="button"
						onClick={() => setView(option)}
						className={
							view === option
								? "rounded border border-border bg-accent px-2 py-1 text-xs"
								: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"
						}
					>
						{option}
					</button>
				))}
				<span className="w-4" />
				{WIDTHS.map((option) => (
					<button
						key={option.label}
						type="button"
						onClick={() => setWidth(option.value)}
						className={
							width === option.value
								? "rounded border border-border bg-accent px-2 py-1 text-xs"
								: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"
						}
					>
						{option.label}
					</button>
				))}
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
					/>
				) : (
					<ToolDetailView
						tool={DETAIL_TOOL}
						search={search}
						onSearchChange={onSearchChange}
						data={detail}
						serviceOptions={facets.services}
						modelOptions={facets.models}
						envOptions={facets.environments}
						modal={
							openError === undefined || errorDetail === undefined ? null : (
								<ToolErrorModal
									tool={DETAIL_TOOL}
									error={openError}
									data={errorDetail}
									toolFailures={detail.errors.reduce((sum, row) => sum + row.calls, 0)}
									session={search.session}
									onSelectSession={(session) => onSearchChange({ session })}
									onClose={() => onSearchChange({ error: undefined, session: undefined })}
								/>
							)
						}
					/>
				)}
			</div>
		</div>
	)
}
