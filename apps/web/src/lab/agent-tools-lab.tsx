import { useMemo, useState } from "react"

import { AgentToolsView } from "@/components/agent-sessions/tools/agent-tools-view"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import { buildToolAnalyticsFixture, buildToolCells, toolFixtureFacets } from "./agent-tools-fixture"

/**
 * `/agent-sessions/tools` without a warehouse behind it.
 *
 * The page is the real one — the route mounts this same `AgentToolsView` — over
 * a week of synthetic tool calls. The URL is stood in for by local state, so
 * every control works: the metric tiles take over the chart, the percentile
 * columns re-key the duration column in both tables, the tool and model rows set
 * the scope and the chart re-splits, the chips remove it again.
 *
 * It exists because `ai_trace_index` is absent from the local Tinybird
 * container, so the real page has nothing to draw locally — this is where a
 * layout or selection change gets looked at.
 *
 * The width buttons matter here: the breakdown row is a container query at
 * 1000px, and each panel's columns drop out at its own widths (the tool
 * sparkline at 520, sessions at 600, the sessions panel's model column at 760).
 */
const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1400px", value: 1400 },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
] as const

export function AgentToolsLab() {
	// One timestamp for the life of the mount: "3m ago" ticking while you look at
	// a spacing change is noise, and the whole fixture is derived from it.
	const [nowMs] = useState(() => Date.now())
	const cells = useMemo(() => buildToolCells(nowMs), [nowMs])
	const facets = useMemo(() => toolFixtureFacets(cells), [cells])

	// Stands in for the URL. Same shape, same defaults-stay-absent rule.
	const [search, setSearch] = useState<ToolAnalyticsSearch>({})
	const [width, setWidth] = useState<number | null>(null)

	const data = useMemo(
		() => buildToolAnalyticsFixture(search, nowMs, cells),
		[search, nowMs, cells],
	)

	return (
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-wrap items-center gap-2">
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

			{/* `@container/page` because the page's breakpoints are container queries
			    against the layout's content column, which is not mounted here. */}
			<div
				className="@container/page min-w-0 rounded-lg border border-border p-4"
				style={width === null ? undefined : { width }}
			>
				<AgentToolsView
					search={search}
					onSearchChange={(patch) => setSearch((prev) => ({ ...prev, ...patch }))}
					data={data}
					serviceOptions={facets.services}
					envOptions={facets.environments}
					windowLabel="7d"
				/>
			</div>
		</div>
	)
}
