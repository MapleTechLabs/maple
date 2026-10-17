import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { runLocalQuery, type LocalQueryRow } from "@maple/query-engine/local"
import { Button } from "@maple/ui/components/ui/button"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { CircleWarningIcon, CodeIcon, DatabaseIcon } from "@maple/ui/components/icons"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { localApiBase } from "../lib/constants"
import {
	DISPLAY_ROW_LIMIT,
	EXAMPLE_QUERIES,
	TABLES_SQL,
	describeQueryError,
	formatCell,
	formatElapsed,
	inferColumns,
	isNumericColumn,
	parseTables,
	tablePreviewSql,
	toCsv,
	toJson,
	truncateCell,
} from "../lib/query-console"
import { useQueryParams } from "../lib/router"
import { PageShell } from "../components/page-shell"
import { Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { EmptyState } from "../components/view-states"
import { failedWithoutData } from "../lib/query"

interface Submission {
	readonly sql: string
	readonly id: string
}

interface ConsoleResult {
	readonly rows: ReadonlyArray<LocalQueryRow>
	readonly elapsedMs: number
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export function QueryView() {
	const [query, setParams] = useQueryParams()
	const sql = query.get("sql") ?? ""
	const setSql = (next: string) => setParams({ sql: next })
	const [submitted, setSubmitted] = useState<Submission | null>(null)
	const queryClient = useQueryClient()
	const resultKey = ["query-console", submitted?.id ?? "", submitted?.sql ?? ""]

	const result = useQuery({
		queryKey: resultKey,
		enabled: submitted !== null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async ({ signal }): Promise<ConsoleResult> => {
			const started = performance.now()
			const rows = await runLocalQuery(submitted?.sql ?? "", localApiBase(), signal)
			return { rows, elapsedMs: performance.now() - started }
		},
	})

	const run = () => {
		const text = sql.trim()
		if (text === "") return
		// A fresh id per submission: a remount must never be served a cached result for the same SQL.
		setSubmitted({ sql: text, id: crypto.randomUUID() })
	}
	// Cancelling reverts a first fetch to pending with no data, so drop the submission too.
	const cancel = () => {
		void queryClient.cancelQueries({ queryKey: resultKey })
		setSubmitted(null)
	}
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			run()
		}
	}

	const rows = result.data?.rows ?? []
	const sidebar = <QuerySidebar onPick={setSql} />
	const toolbar = (
		<Toolbar>
			<ToolbarStats className="flex-wrap">
				{result.data ? (
					<>
						<ToolbarStat value={rows.length} label={rows.length === 1 ? "row" : "rows"} />
						<span className="text-sm whitespace-nowrap text-muted-foreground">
							<span className="font-medium tabular-nums text-foreground">
								{formatElapsed(result.data.elapsedMs)}
							</span>{" "}
							elapsed
						</span>
					</>
				) : (
					<span className="text-sm text-muted-foreground">
						Read-only SQL against the local chDB tables
					</span>
				)}
			</ToolbarStats>
			<ToolbarStats className="shrink-0 gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={rows.length === 0}
					onClick={() => downloadText("maple-query.csv", toCsv(rows), "text/csv")}
				>
					CSV
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={rows.length === 0}
					onClick={() => downloadText("maple-query.json", toJson(rows), "application/json")}
				>
					JSON
				</Button>
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			<div className="flex h-full min-h-0 flex-col">
				<div className="space-y-2 border-b p-4">
					<Textarea
						value={sql}
						onChange={(event) => setSql(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={`SELECT * FROM traces WHERE OrgId = 'local' LIMIT 100`}
						spellCheck={false}
						aria-label="SQL query"
						controlClassName="max-h-72 min-h-28 font-mono text-xs leading-relaxed"
					/>
					<div className="flex items-center justify-between gap-2">
						<span className="flex items-center gap-1 text-xs text-muted-foreground">
							<Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
							<Kbd>Enter</Kbd>
							<span className="ml-1">to run</span>
						</span>
						{result.isFetching ? (
							<Button variant="outline" size="sm" onClick={cancel} className="gap-1.5">
								<Spinner className="size-3.5" />
								Cancel
							</Button>
						) : (
							<Button size="sm" onClick={run} disabled={sql.trim() === ""}>
								Run
							</Button>
						)}
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-auto">
					{submitted === null ? (
						<EmptyState
							icon={<CodeIcon />}
							title="Run a query"
							hint="Pick a table or an example from the sidebar, or write your own SELECT. Every table is scoped by OrgId = 'local'."
						/>
					) : result.isError ? (
						<QueryError error={result.error} />
					) : result.isPending ? (
						<div className="flex h-24 items-center justify-center">
							<Spinner className="size-4" />
						</div>
					) : rows.length === 0 ? (
						<EmptyState title="No rows" hint="The query ran and returned an empty result." />
					) : (
						<ResultTable rows={rows} />
					)}
				</div>
			</div>
		</PageShell>
	)
}

function QuerySidebar({ onPick }: { onPick: (sql: string) => void }) {
	const tables = useQuery({
		queryKey: ["local", "query-console", "tables"],
		queryFn: ({ signal }) =>
			runLocalQuery(TABLES_SQL, localApiBase(), signal).then((rows) => parseTables(rows)),
		retry: false,
	})
	return (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={tables.isFetching}>
			<FilterSidebarHeader title="Tables" />
			<FilterSidebarBody>
				{tables.isPending ? (
					<div className="flex h-12 items-center justify-center">
						<Spinner className="size-4" />
					</div>
				) : failedWithoutData(tables) ? (
					<p className="text-xs break-all text-destructive">
						{describeQueryError(tables.error).detail}
					</p>
				) : (
					<ul className="space-y-0.5">
						{tables.data.map((table) => (
							<li key={table.name}>
								<SidebarItem
									title={`Insert SELECT * FROM ${table.name}`}
									onClick={() => onPick(tablePreviewSql(table.name))}
								>
									<DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate font-mono">{table.name}</span>
									{table.totalRows !== null ? (
										<span className="shrink-0 tabular-nums text-muted-foreground">
											{formatNumber(table.totalRows)}
										</span>
									) : null}
								</SidebarItem>
							</li>
						))}
					</ul>
				)}
				<Eyebrow as="h3" variant="label" className="pt-4 pb-1">
					Examples
				</Eyebrow>
				<ul className="space-y-0.5">
					{EXAMPLE_QUERIES.map((example) => (
						<li key={example.label}>
							<SidebarItem title={example.sql} onClick={() => onPick(example.sql)}>
								<CodeIcon className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{example.label}</span>
							</SidebarItem>
						</li>
					))}
				</ul>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}

function SidebarItem({
	title,
	onClick,
	children,
}: {
	title: string
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60"
		>
			{children}
		</button>
	)
}

function QueryError({ error }: { error: unknown }) {
	const { title, detail } = describeQueryError(error)
	return (
		<div className="p-4">
			<div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
				<div className="flex items-center gap-2 text-sm font-medium text-destructive">
					<CircleWarningIcon className="size-4 shrink-0" />
					{title}
				</div>
				<pre className="mt-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground">
					{detail}
				</pre>
			</div>
		</div>
	)
}

function ResultTable({ rows }: { rows: ReadonlyArray<LocalQueryRow> }) {
	const columns = useMemo(() => inferColumns(rows), [rows])
	const numeric = useMemo(
		() => new Set(columns.filter((column) => isNumericColumn(rows, column))),
		[rows, columns],
	)
	const shown = rows.length > DISPLAY_ROW_LIMIT ? rows.slice(0, DISPLAY_ROW_LIMIT) : rows
	return (
		<div>
			<table className="w-max min-w-full border-separate border-spacing-0 font-mono text-xs">
				<thead>
					<tr>
						{columns.map((column) => (
							<th
								key={column}
								className={cn(
									"sticky top-0 z-10 border-b bg-background px-3 py-2 font-medium whitespace-nowrap text-muted-foreground",
									numeric.has(column) ? "text-right" : "text-left",
								)}
							>
								{column}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{shown.map((row, index) => (
						<tr key={index} className="hover:bg-accent/40">
							{columns.map((column) => {
								const text = formatCell(row[column])
								const isNull = row[column] == null
								return (
									<td
										key={column}
										title={text}
										className={cn(
											"border-b border-border/50 px-3 py-1.5 whitespace-nowrap",
											numeric.has(column) && "text-right tabular-nums",
											isNull && "text-muted-foreground/60",
										)}
									>
										{truncateCell(text)}
									</td>
								)
							})}
						</tr>
					))}
				</tbody>
			</table>
			{rows.length > DISPLAY_ROW_LIMIT ? (
				<p className="px-3 py-2 text-xs text-muted-foreground">
					Showing the first {formatNumber(DISPLAY_ROW_LIMIT)} of {formatNumber(rows.length)} rows.
					Download CSV or JSON for the full result.
				</p>
			) : null}
		</div>
	)
}

/** Save text as a file from a click handler; the object URL is released right after. */
function downloadText(filename: string, text: string, type: string) {
	const url = URL.createObjectURL(new Blob([text], { type }))
	const anchor = document.createElement("a")
	anchor.href = url
	anchor.download = filename
	anchor.click()
	URL.revokeObjectURL(url)
}
