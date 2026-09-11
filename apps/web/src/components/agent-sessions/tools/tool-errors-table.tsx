import { useMemo } from "react"

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { useTableSort } from "@/components/infra/primitives/data-table"
import { QueryErrorState } from "@/components/common/query-error-state"
import { ChevronRightIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	errorTypeLabel,
	formatToolCount,
	type ToolErrorRow,
} from "@/lib/agent-sessions/tool-analytics"

import {
	ROW,
	ROW_IDLE,
	ROW_SELECTED,
	ShareCell,
	Table,
	TableBody,
	TableEmpty,
	TableHead,
	Th,
} from "./tool-breakdown-tables"

type ErrorSortKey = "errorType" | "calls" | "sessions" | "lastSeen"

/**
 * How one tool fails, ranked — the tool detail page's answer to the error rate
 * above it.
 *
 * Keyed on `error.type` rather than on the message, because a message carries
 * the detail that makes every occurrence unique (a path, a worker count) and a
 * table keyed on it would be a list of occurrences. The message shown is the
 * most recent one under the type, which is the one a reader is about to go
 * looking at.
 *
 * SHARE is of this tool's failures, not of its calls: the column is answering
 * "which failure should I fix first", and the rate against all calls is already
 * the tile at the top of the page.
 */
export function ToolErrorsTable({
	rows,
	tool,
	selected,
	onSelect,
	loading,
	failure,
	waiting,
}: {
	rows: ReadonlyArray<ToolErrorRow>
	tool: string
	/** The error type a modal is open on, drawn as the selected row. */
	selected: string | undefined
	onSelect: (errorType: string) => void
	/** The read has not answered yet. Distinct from an empty result: "no failed
	 *  calls" is a finding, and a table that states it while still loading is
	 *  stating something it does not know. */
	loading?: boolean
	/** The read failed — the same distinction, from the other side. */
	failure?: unknown
	waiting?: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const failures = rows.reduce((sum, row) => sum + row.calls, 0)
	const prepared = useMemo(
		() => rows.map((row) => ({ ...row, share: failures > 0 ? row.calls / failures : 0 })),
		[rows, failures],
	)
	const maxShare = useMemo(
		() => prepared.reduce((max, row) => Math.max(max, row.share), 0),
		[prepared],
	)
	const { sorted, sortKey, sortDir, handleSort } = useTableSort(prepared, {
		initialKey: "calls" as ErrorSortKey,
		stringKeys: ["errorType"],
	})

	return (
		<section className="@container/panel min-w-0 border-b border-border px-6 pt-5 pb-4" aria-label="Errors">
			<div className="flex items-baseline gap-2.5 pb-3 font-mono">
				<span className="text-[12.5px] font-medium text-foreground">Errors</span>
				<span className="text-[11.5px] leading-3.5 tabular-nums text-muted-foreground/70">
					{formatToolCount(failures)} failed call{failures === 1 ? "" : "s"}
				</span>
			</div>

			<Table>
				<TableHead>
					<Th<ErrorSortKey>
						label="Type"
						width="w-[180px] shrink-0"
						sortKey="errorType"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th label="Message" width="w-0 flex-1 min-w-0" />
					<Th label="Share" width="w-[150px] shrink-0 pl-6" />
					<Th<ErrorSortKey>
						label="Count"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="calls"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
					/>
					<Th<ErrorSortKey>
						label="Sessions"
						width="w-[76px] shrink-0"
						align="right"
						sortKey="sessions"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[640px]/panel:flex"
					/>
					<Th<ErrorSortKey>
						label="Last seen"
						width="w-[96px] shrink-0"
						align="right"
						sortKey="lastSeen"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						hidden="hidden @min-[800px]/panel:flex"
					/>
					<span className="w-3.5 shrink-0" aria-hidden />
				</TableHead>

				<TableBody waiting={waiting}>
					{failure !== undefined ? (
						<QueryErrorState
							error={failure}
							titleOverride={`Failed to load ${tool} errors`}
						/>
					) : loading ? (
						<div className="flex flex-col gap-1.5 px-2.5 py-3">
							<Skeleton className="h-[38px]" />
							<Skeleton className="h-[38px]" />
							<Skeleton className="h-[38px]" />
						</div>
					) : sorted.length === 0 ? (
						<TableEmpty>No failed {tool} calls in the selected window.</TableEmpty>
					) : (
						sorted.map((row) => (
							<button
								key={row.errorType}
								type="button"
								aria-pressed={row.errorType === selected}
								onClick={() => onSelect(row.errorType)}
								className={cn(ROW, row.errorType === selected ? ROW_SELECTED : ROW_IDLE)}
							>
								<span
									className={cn(
										"w-[180px] shrink-0 truncate font-mono text-[12.5px]",
										// A failure that named no type is not a type: it is drawn
										// as the absence it is, so the column's colour keeps
										// meaning "this is what it called itself".
										row.errorType === ""
											? "text-muted-foreground"
											: "text-[var(--severity-error)]",
									)}
									title={errorTypeLabel(row.errorType)}
								>
									{errorTypeLabel(row.errorType)}
								</span>
								<span
									className="w-0 min-w-0 flex-1 truncate text-left font-mono text-[12.5px] text-foreground"
									title={row.message}
								>
									{row.message === "" ? (
										<span className="text-muted-foreground">
											span failed without an error.type or status message
										</span>
									) : (
										row.message
									)}
								</span>
								<ShareCell
									ratio={row.share}
									max={maxShare}
									label={`${Math.round(row.share * 100)}%`}
									tone={{
										bar: "bg-[var(--severity-error)]",
										text: "text-muted-foreground",
									}}
								/>
								<span className="w-[76px] shrink-0 text-right font-mono text-[12.5px] tabular-nums text-foreground">
									{formatToolCount(row.calls)}
								</span>
								<span className="hidden w-[76px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @min-[640px]/panel:block">
									{formatToolCount(row.sessions)}
								</span>
								<span className="hidden w-[96px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground/70 @min-[800px]/panel:block">
									{formatRelativeTimeOrDate(row.lastSeen, undefined, effectiveTimezone)}
								</span>
								<span className="flex w-3.5 shrink-0 items-center justify-end text-muted-foreground/60">
									<ChevronRightIcon size={14} aria-hidden />
								</span>
							</button>
						))
					)}
				</TableBody>
			</Table>
		</section>
	)
}
