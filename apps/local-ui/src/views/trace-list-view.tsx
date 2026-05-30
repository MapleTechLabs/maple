import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@maple/ui/components/ui/table"
import { formatDuration } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import { useLocalTraces } from "../hooks/use-local-traces"
import { useLocalServices } from "../hooks/use-local-services"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { SearchableFilterSection, SingleCheckboxFilter } from "../components/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "../components/filter-sidebar"
import { PageShell } from "../components/page-shell"
import { Toolbar, ToolbarSearch, ToolbarStat, TimeRangeSelect } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"

interface TraceListViewProps {
	onSelectTrace: (traceId: string) => void
}

export function TraceListView({ onSelectTrace }: TraceListViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const errorsOnly = query.get("errors") === "1"
	const search = query.get("q") || undefined

	const services = useLocalServices(range)
	const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalTraces({ service, search, errorsOnly, range })
	const rows = data?.pages.flat() ?? []

	const hasActiveFilters = !!service || errorsOnly

	const sidebar = (
		<FilterSidebarFrame waiting={services.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, errors: null })}
			/>
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Errors only"
					checked={errorsOnly}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
				/>
				{(services.data?.length ?? 0) > 0 && (
					<>
						<Separator className="my-2" />
						<SearchableFilterSection
							title="Service"
							options={(services.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
							selected={service ? [service] : []}
							onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
						/>
					</>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar
			search={
				<ToolbarSearch
					query={search ?? ""}
					onSearch={(value) => setParams({ q: value ?? null })}
					placeholder="Filter by span name…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={rows.length} label={hasNextPage ? "traces+" : "traces"} />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{isPending ? (
				<div className="flex h-full items-center justify-center">
					<Spinner />
				</div>
			) : isError ? (
				<ErrorState label="traces" error={error} />
			) : rows.length === 0 ? (
				<EmptyState
					title={hasActiveFilters || search ? "No matching traces" : "No traces yet"}
					hint={
						hasActiveFilters || search
							? "Try widening the time range or clearing filters."
							: "Send OTLP spans to the local ingest endpoint to get started."
					}
				/>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[40%]">Trace</TableHead>
								<TableHead>Service</TableHead>
								<TableHead className="text-right">Duration</TableHead>
								<TableHead className="text-right">Spans</TableHead>
								<TableHead>Time</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow
									key={row.traceId}
									className={cn("cursor-pointer", row.hasError && "bg-destructive/5")}
									onClick={() => onSelectTrace(row.traceId)}
								>
									<TableCell className="min-w-0">
										<div className="flex items-center gap-2">
											{row.hasError ? (
												<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
											) : null}
											<HttpSpanLabel
												spanName={row.rootSpanName}
												spanKind={row.rootSpanKind}
												spanAttributes={{
													"http.method": row.rootHttpMethod,
													"http.route": row.rootHttpRoute,
													"http.status_code": row.rootHttpStatusCode,
												}}
												className="min-w-0"
											/>
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground">
										<div className="flex flex-wrap gap-1">
											{row.services.slice(0, 3).map((svc) => (
												<Badge key={svc} variant="secondary" className="font-mono text-[10px]">
													{svc}
												</Badge>
											))}
											{row.services.length > 3 ? (
												<Badge variant="secondary" className="font-mono text-[10px]">
													+{row.services.length - 3}
												</Badge>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-right font-mono tabular-nums">
										{formatDuration(row.durationMicros / 1000)}
									</TableCell>
									<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
										{row.spanCount}
									</TableCell>
									<TableCell className="font-mono text-xs text-muted-foreground">
										{row.startTime}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>

					{hasNextPage ? (
						<div className="flex justify-center p-4">
							<Button
								variant="outline"
								size="sm"
								onClick={() => fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? <Spinner className="size-4" /> : "Load more"}
							</Button>
						</div>
					) : null}
				</>
			)}
		</PageShell>
	)
}
