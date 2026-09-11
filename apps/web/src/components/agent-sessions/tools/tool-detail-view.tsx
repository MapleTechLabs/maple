import type { ReactNode } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import {
	formatToolCount,
	scopeSummary,
	type ToolErrorRow,
	type ToolSeriesPoint,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import { ToolDetailCharts } from "./tool-detail-charts"
import { ToolDetailSessions } from "./tool-detail-sessions"
import { ToolErrorsTable } from "./tool-errors-table"
import { ToolFilterToolbar, type ToolFilterOption } from "./tool-filter-toolbar"
import { ToolScopeRow, type ToolScopeChip } from "./tool-scope-row"

export interface ToolDetailViewData {
	readonly series: ReadonlyArray<ToolSeriesPoint>
	readonly totals: ToolTotals
	/** The tool's calls before the toolbar's predicates — the "of M" denominator. */
	readonly scopeCalls: number
	/** Epoch ms of the tool's first and last call in the window; 0 where it never ran. */
	readonly firstSeen: number
	readonly lastSeen: number
	/** The tool's latest `gen_ai.tool.description`; absent where no call stamped one. */
	readonly description?: string
	readonly errors: ReadonlyArray<ToolErrorRow>
	/** The Errors read's state, so an empty table is only ever a finding. */
	readonly errorsLoading: boolean
	readonly errorsFailure: unknown
	readonly sessions: ReadonlyArray<AgentSessionRow>
	/** The sessions read came back full — there are older ones it did not show. */
	readonly sessionsCapped: boolean
	readonly sessionsLoading: boolean
	readonly sessionsFailure: unknown
}

/**
 * `/agent-sessions/tools/$toolName` below the layout chrome, over resolved data.
 *
 * The overview ranks tools against each other; this page stops comparing. Four
 * charts of one tool, then the two things a reader came for once a tool is
 * suspect: how it fails, and which sessions it failed in. The toolbar and the
 * scope band are the overview's, unchanged — the window and the filters travel
 * with the reader, and the scope band states the tool as the denominator it now
 * is ("1,942 of 3,908 run_tests calls match").
 */
export function ToolDetailView({
	tool,
	search,
	onSearchChange,
	data,
	serviceOptions,
	modelOptions,
	envOptions,
	headerControls,
	modal,
	waiting,
}: {
	tool: string
	search: ToolAnalyticsSearch
	onSearchChange: (patch: Partial<ToolAnalyticsSearch>) => void
	data: ToolDetailViewData
	serviceOptions: ReadonlyArray<ToolFilterOption>
	modelOptions: ReadonlyArray<ToolFilterOption>
	envOptions: ReadonlyArray<ToolFilterOption>
	headerControls?: ReactNode
	/** The error modal, mounted by the route when the URL carries an error type. */
	modal?: ReactNode
	waiting?: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()

	// Bounded by the window, so this is "first seen in this range" — which is
	// what a page whose every other number is windowed should say.
	const subtitle = [
		`${formatToolCount(data.totals.calls)} call${data.totals.calls === 1 ? "" : "s"} in ${formatToolCount(data.totals.sessions)} session${data.totals.sessions === 1 ? "" : "s"}`,
		data.firstSeen > 0
			? `first seen ${formatTimestampInTimezone(data.firstSeen, { timeZone: effectiveTimezone })}`
			: undefined,
		data.lastSeen > 0
			? `last call ${formatRelativeTimeOrDate(data.lastSeen, undefined, effectiveTimezone)}`
			: undefined,
	].filter((part) => part !== undefined)

	const chips: ReadonlyArray<ToolScopeChip> =
		search.model === undefined ? [] : [{ kind: "model", value: search.model }]

	return (
		<div className="flex flex-col">
			<header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-[22px] pb-4">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex min-w-0 items-baseline gap-3">
						<h1 className="truncate font-mono text-[26px] font-semibold leading-8 tracking-[-0.01em] text-foreground">
							{tool}
						</h1>
						{data.description !== undefined && (
							<Tooltip>
								{/* `w-0 flex-1`: fills the row beside the name without its own
								    width pushing the header controls onto the next line. */}
								<TooltipTrigger
									render={<span />}
									className="w-0 min-w-0 flex-1 cursor-default truncate text-[13px] leading-[18px] text-muted-foreground"
								>
									{data.description}
								</TooltipTrigger>
								<TooltipContent className="max-w-md">{data.description}</TooltipContent>
							</Tooltip>
						)}
					</div>
					<p className="font-mono text-[13px] leading-[18px] text-muted-foreground">
						{subtitle.join(" · ")}
					</p>
				</div>
				{headerControls ? (
					<div className="flex shrink-0 items-center gap-2 pt-1">{headerControls}</div>
				) : null}
			</header>

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
				summary={scopeSummary(data.totals, data.scopeCalls, tool)}
				onRemove={() => onSearchChange({ model: undefined })}
				onClearAll={() => onSearchChange({ model: undefined })}
			/>

			<ToolDetailCharts series={data.series} waiting={waiting} />

			<ToolErrorsTable
				rows={data.errors}
				tool={tool}
				selected={search.error}
				// Opening a different error drops the session the last one was
				// narrowed to — a `?session=` left behind would narrow occurrences
				// of an error that never happened in it.
				onSelect={(errorType) => onSearchChange({ error: errorType, session: undefined })}
				loading={data.errorsLoading}
				failure={data.errorsFailure}
				waiting={waiting}
			/>

			<ToolDetailSessions
				rows={data.sessions}
				tool={tool}
				capped={data.sessionsCapped}
				loading={data.sessionsLoading}
				failure={data.sessionsFailure}
				waiting={waiting}
			/>

			{modal}
		</div>
	)
}
