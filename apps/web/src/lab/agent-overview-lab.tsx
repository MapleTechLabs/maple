import { useMemo, useState } from "react"

import { AgentOverviewView } from "@/components/agent-sessions/overview/agent-overview-view"
import { buildAgentOverviewData } from "@/lib/agent-sessions/overview-analytics"
import { compareEnabled, type AgentOverviewSearch } from "@/lib/agent-sessions/overview-search"

import {
	OVERVIEW_SCENARIOS,
	buildOverviewFixture,
	type OverviewScenario,
} from "./agent-overview-fixture"

/**
 * The overview board without a warehouse behind it.
 *
 * The page is the real one — the route mounts this same view — over two
 * synthetic boards: a healthy week, and a day whose 14:00 UTC step is what the
 * movers rail and the error charts are for. The URL is stood in for by local
 * state, so every control works: the selects and the toggles narrow the scope
 * row, a breakdown row filters the page, and a mover line does the same.
 *
 * The width buttons matter here: the strip folds from seven columns to four to
 * two, and the trends grid from three columns to two to one, at container
 * widths the layout's content column does not have in this page.
 */
const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1400px", value: 1400 },
	{ label: "1100px", value: 1100 },
	{ label: "820px", value: 820 },
] as const

const SCENARIO_LABEL = {
	healthy7d: "healthy · 7d",
	regression24h: "regression · 24h",
} satisfies Record<OverviewScenario, string>

export function AgentOverviewLab() {
	// One timestamp for the life of the mount: the whole fixture is derived from
	// it, and a re-derived "now" while you look at a spacing change is noise.
	const [nowMs] = useState(() => Date.now())
	const [scenario, setScenario] = useState<OverviewScenario>("healthy7d")
	const [search, setSearch] = useState<AgentOverviewSearch>({})
	const [width, setWidth] = useState<number | null>(null)

	const fixture = useMemo(() => buildOverviewFixture(scenario, nowMs), [scenario, nowMs])
	const data = useMemo(
		() => buildAgentOverviewData({ ...fixture.input, compare: compareEnabled(search) }),
		[fixture, search],
	)

	const onSearchChange = (patch: Partial<AgentOverviewSearch>) =>
		setSearch((previous) => ({ ...previous, ...patch }))

	return (
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-wrap items-center gap-2">
				{OVERVIEW_SCENARIOS.map((option) => (
					<button
						key={option}
						type="button"
						onClick={() => setScenario(option)}
						className={
							scenario === option
								? "rounded border border-border bg-accent px-2 py-1 text-xs"
								: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"
						}
					>
						{SCENARIO_LABEL[option]}
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

			{/* `@container/page` because the page's breakpoints are container queries
			    against the layout's content column, which is not mounted here. */}
			<div
				className="@container/page min-w-0 overflow-hidden rounded-lg border border-border"
				style={width === null ? undefined : { width }}
			>
				<AgentOverviewView
					search={search}
					onSearchChange={onSearchChange}
					data={data}
					facets={fixture.facets}
					topSessions={fixture.topSessions}
					windowLabel={fixture.windowLabel}
				/>
			</div>
		</div>
	)
}
