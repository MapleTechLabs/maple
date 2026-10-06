import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { countLabel, formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { errorRateClass, errorRateLevel } from "@maple/ui/lib/error-rate"
import { ErrorRateValue } from "@maple/ui/components/error-rate-value"
import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getServiceEndpointsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ErrorState } from "@/components/common/error-state"
import { DocsLink } from "@/components/common/docs-link"
import type { ServiceEndpoint } from "@/api/warehouse/service-endpoints"
import {
	BarCell,
	MobileListRow,
	MobileSortBar,
	MobileStat,
	MobileStatLine,
	SortColumnHead,
	TABLE_CARD_CLASS,
} from "./service-table-cells"
import { SampledValue } from "./sampled-value"
import { useSortState } from "@/hooks/use-table-sort"
import { ENDPOINTS_LIMIT, isTruncated, serviceEndpointsQueryInput } from "./service-endpoints"
import { callsPerSecond, operationTraceSearch, windowSeconds } from "./service-operations"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { groupEndpoints, leafLabel, type EndpointGroup, type EndpointSort } from "./endpoint-grouping"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"

interface ServiceApiTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Raw search params, forwarded to the /traces drill-down so relative presets stay live. */
	startTime?: string
	endTime?: string
	timePreset?: string
}

/**
 * Muted by default; only the mutating verbs earn a tint. The Paper direction
 * tinted GET green, but the palette has no success token — severity is
 * trace/debug/info/warn/error/fatal — and adding one for a method label is a
 * palette decision, not a table decision. Read-only verbs stay muted.
 */
const methodTone = (method: string): string => {
	switch (method) {
		case "POST":
		case "PUT":
		case "PATCH":
			return "text-severity-warn"
		case "DELETE":
			return "text-severity-error"
		default:
			return "text-muted-foreground"
	}
}

const COLUMN = {
	rate: "w-[96px]",
	err: "w-[84px]",
	p50: "w-[84px]",
	p95: "w-[96px]",
	p99: "w-[84px]",
} as const

export function ServiceApiTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
}: ServiceApiTabProps) {
	const navigate = useNavigate()
	const { sortKey, sortDir, handleSort } = useSortState<EndpointSort>({
		initialKey: "traffic",
		stringKeys: ["path"],
	})
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

	const result = useRefreshableAtomValue(
		getServiceEndpointsResultAtom({
			data: serviceEndpointsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const seconds = windowSeconds(effectiveStartTime, effectiveEndTime)
	const traceDetailLimited = seconds > 30 * 24 * 60 * 60
	const traceDetailStartTime = traceDetailLimited
		? // normalizeTimestampInput first: the effective range carries warehouse
			// timestamps ("2026-08-31 12:00:00"), which Date.parse reads as LOCAL time.
			// Outside UTC that shifts the drill-down's 30-day window by the offset.
			new Date(
				Date.parse(normalizeTimestampInput(effectiveEndTime)) - 30 * 24 * 60 * 60 * 1000,
			).toISOString()
		: startTime

	const endpoints = useMemo<ServiceEndpoint[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.endpoints])
				.orElse(() => []),
		[result],
	)

	const groups = useMemo(
		() => groupEndpoints(endpoints, sortKey ?? "traffic", sortDir),
		[endpoints, sortKey, sortDir],
	)

	// Column-relative maxima drive the inline bars, computed over real endpoints
	// only — a scanner probe at 100% errors must not flatten every real bar.
	const { served, maxima } = useMemo(() => {
		const servedGroups = groups.filter((group) => group.kind === "stem" || group.kind === "ungrouped")
		const servedEndpoints = servedGroups.flatMap((group) => group.endpoints)
		return {
			served: {
				count: servedEndpoints.length,
				spanCount: servedEndpoints.reduce((sum, e) => sum + e.estimatedSpanCount, 0),
				errorCount: servedEndpoints.reduce((sum, e) => sum + e.estimatedErrorCount, 0),
				p99DurationMs: servedEndpoints.reduce((worst, e) => Math.max(worst, e.p99DurationMs), 0),
			},
			maxima: servedEndpoints.reduce(
				(acc, e) => ({
					calls: Math.max(acc.calls, e.estimatedSpanCount),
					p95: Math.max(acc.p95, e.p95DurationMs),
				}),
				{ calls: 0, p95: 0 },
			),
		}
	}, [groups])

	const toggleExpanded = (kind: string) =>
		setExpanded((open) => {
			const next = new Set(open)
			if (!next.delete(kind)) next.add(kind)
			return next
		})

	const handleRowClick = (endpoint: ServiceEndpoint) => {
		navigate({
			to: "/traces",
			search: operationTraceSearch({
				serviceName,
				spanName: endpoint.spanName,
				environments,
				startTime: traceDetailStartTime,
				endTime: traceDetailLimited ? effectiveEndTime : endTime,
				timePreset: traceDetailLimited ? undefined : timePreset,
			}),
		})
	}

	if (!Result.isSuccess(result)) {
		return Result.builder(result)
			.onError((error) => <ErrorState error={error} />)
			.orElse(() => <ApiLoadingState />)
	}

	if (endpoints.length === 0) {
		return <ApiEmptyState serviceName={serviceName} />
	}

	const isWaiting = result.waiting
	const servedErrorRate = served.spanCount > 0 ? served.errorCount / served.spanCount : 0
	const notes: string[] = []
	if (isTruncated(endpoints.length)) {
		notes.push(
			`Showing the ${ENDPOINTS_LIMIT} busiest endpoints — this service has more. Narrow the time range or environment to see the rest.`,
		)
	}
	if (traceDetailLimited) {
		notes.push("Endpoint summaries cover the selected range; trace drill-downs show the latest 30 days.")
	}

	return (
		<div
			className={cn("flex flex-col gap-2", refreshingClass(isWaiting))}
			aria-busy={isWaiting || undefined}
		>
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-0.5 text-xs">
				<Stat label="endpoints" value={served.count.toLocaleString()} />
				<Stat label="req/s" value={formatRate(callsPerSecond(served.spanCount, seconds))} />
				<Stat
					label="errors"
					value={formatErrorRate(servedErrorRate)}
					className={errorRateClass(servedErrorRate)}
				/>
				<Stat label="worst p99" value={formatLatency(served.p99DurationMs)} />
				{notes.map((note) => (
					<span key={note} className="text-muted-foreground">
						{note}
					</span>
				))}
			</div>

			{/* Desktop: grouped, sortable table with inline distribution bars. */}
			<div className={cn("hidden md:block", TABLE_CARD_CLASS)}>
				<Table>
					<TableHeader>
						<TableRow className="border-b hover:bg-transparent">
							<SortColumnHead
								label="Endpoint"
								sortKey="path"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
								align="left"
								className="pl-3"
							/>
							<SortColumnHead
								label="Req/s"
								sortKey="traffic"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
								className={COLUMN.rate}
							/>
							<SortColumnHead
								label="Errors"
								sortKey="errorRate"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
								className={COLUMN.err}
							/>
							<SortColumnHead
								label="p50"
								sortKey="p50"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
								className={COLUMN.p50}
							/>
							<SortColumnHead
								label="p95"
								sortKey="p95"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
								className={COLUMN.p95}
							/>
							<SortColumnHead
								label="p99"
								sortKey="p99"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
								className={cn(COLUMN.p99, "pr-3")}
							/>
						</TableRow>
					</TableHeader>
					<TableBody>
						{groups.map((group) => (
							<GroupRows
								key={groupKey(group)}
								group={group}
								seconds={seconds}
								maxima={maxima}
								expanded={expanded.has(group.kind)}
								onToggle={() => toggleExpanded(group.kind)}
								onSelect={handleRowClick}
							/>
						))}
					</TableBody>
				</Table>
			</div>

			{/* Mobile: tap-to-trace list with a compact sort control. */}
			<div className="space-y-2 md:hidden">
				<MobileSortBar
					options={
						[
							["traffic", "Traffic"],
							["errorRate", "Errors"],
							["p95", "p95"],
							["path", "Path"],
						] as const
					}
					sortKey={sortKey}
					sortDir={sortDir}
					onSort={handleSort}
				/>
				<div className={TABLE_CARD_CLASS}>
					{groups.map((group) => (
						<MobileGroup
							key={groupKey(group)}
							group={group}
							seconds={seconds}
							expanded={expanded.has(group.kind)}
							onToggle={() => toggleExpanded(group.kind)}
							onSelect={handleRowClick}
						/>
					))}
				</div>
			</div>
		</div>
	)
}

/** Headerless singletons all have an empty stem, so they key on their endpoint. */
const groupKey = (group: EndpointGroup): string =>
	group.kind === "ungrouped"
		? `endpoint:${group.endpoints[0]?.spanName ?? ""}`
		: `${group.kind}:${group.stem}`

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
	return (
		<span className="inline-flex items-baseline gap-1">
			<span className={cn("font-mono font-medium tabular-nums text-foreground", className)}>
				{value}
			</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	)
}

interface Maxima {
	calls: number
	p95: number
}

interface GroupRowsProps {
	group: EndpointGroup
	seconds: number
	maxima: Maxima
	expanded: boolean
	onToggle: () => void
	onSelect: (endpoint: ServiceEndpoint) => void
}

/**
 * Copy for the two groups that are collapsed by default. Both exist because the
 * rollup cannot tell us whether a span carried `http.route`, so both are read
 * from the route text, and both are one click from being shown in full — a wrong
 * guess costs a click, never a hidden endpoint.
 */
const COLLAPSED_COPY = {
	unrouted: {
		label: "Unrouted paths",
		explainer: "URL paths rather than route templates — each distinct id counts as its own endpoint.",
	},
	probes: {
		label: "Scanner probes",
		explainer:
			"Paths no route matched, in the shape bots scan for. Kept out of the endpoint list, not deleted.",
	},
} as const

function GroupRows({ group, seconds, maxima, expanded, onToggle, onSelect }: GroupRowsProps) {
	if (group.kind === "unrouted" || group.kind === "probes") {
		const copy = COLLAPSED_COPY[group.kind]
		const sample = group.endpoints.slice(0, 2).map((endpoint) => endpoint.route)
		const remaining = group.endpoints.length - sample.length
		return (
			<>
				<GroupHeaderRow
					title={copy.label}
					count={countLabel(group.endpoints.length, "path")}
					group={group}
					seconds={seconds}
					muted
				/>
				<TableRow className="border-b hover:bg-transparent">
					<TableCell colSpan={6} className="py-2.5 pl-3 pr-3">
						<div className="flex items-center gap-4">
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-xs text-muted-foreground">{copy.explainer}</span>
								<span className="truncate font-mono text-[11px] text-muted-foreground/50">
									{sample.join("  ·  ")}
									{remaining > 0 ? `  ·  ${remaining.toLocaleString()} more` : ""}
								</span>
							</div>
							<Button variant="outline" size="sm" onClick={onToggle} className="shrink-0">
								{expanded ? "Hide" : "Show anyway"}
							</Button>
						</div>
					</TableCell>
				</TableRow>
				{expanded
					? group.endpoints.map((endpoint) => (
							<EndpointRow
								key={endpoint.spanName}
								endpoint={endpoint}
								stem=""
								seconds={seconds}
								maxima={maxima}
								onSelect={onSelect}
							/>
						))
					: null}
			</>
		)
	}
	return (
		<>
			{group.kind === "stem" && (
				<GroupHeaderRow
					title={group.stem}
					count={countLabel(group.endpoints.length, "endpoint")}
					group={group}
					seconds={seconds}
				/>
			)}
			{group.endpoints.map((endpoint) => (
				<EndpointRow
					key={endpoint.spanName}
					endpoint={endpoint}
					stem={group.stem}
					seconds={seconds}
					maxima={maxima}
					onSelect={onSelect}
				/>
			))}
		</>
	)
}

/**
 * A group's totals sit in the same columns as its rows so the eye never leaves
 * the rail. p50 stays empty — a group has no p50 — and the p95/p99 cells carry
 * the worst endpoint in the group, which is what a summary of a tail should be.
 */
function GroupHeaderRow({
	title,
	count,
	group,
	seconds,
	muted = false,
}: {
	title: string
	count: string
	group: EndpointGroup
	seconds: number
	muted?: boolean
}) {
	const numeric =
		"py-1.5 text-right align-middle font-mono text-[11.5px] tabular-nums text-muted-foreground/70"
	return (
		<TableRow className="border-b bg-muted/30 hover:bg-muted/30">
			<TableCell className="max-w-0 py-1.5 pl-3 align-middle">
				<div className="flex min-w-0 items-baseline gap-2">
					<span
						className={cn(
							"truncate font-mono text-xs font-medium",
							muted ? "text-muted-foreground" : "text-foreground",
						)}
						title={title}
					>
						{title}
					</span>
					<span className="shrink-0 text-[11px] text-muted-foreground/60">{count}</span>
				</div>
			</TableCell>
			<TableCell className={cn(numeric, "pr-1.5")}>
				{formatRate(callsPerSecond(group.totals.estimatedSpanCount, seconds))}
			</TableCell>
			<TableCell
				className={cn(
					numeric,
					"pr-1.5",
					errorRateLevel(group.totals.errorRate) !== "neutral" &&
						errorRateClass(group.totals.errorRate),
				)}
			>
				{formatErrorRate(group.totals.errorRate)}
			</TableCell>
			<TableCell className={numeric} />
			<TableCell className={cn(numeric, "pr-1.5")} title="Worst p95 in the group">
				{formatLatency(group.totals.p95DurationMs)}
			</TableCell>
			<TableCell className={cn(numeric, "pr-3")} title="Worst p99 in the group">
				{formatLatency(group.totals.p99DurationMs)}
			</TableCell>
		</TableRow>
	)
}

function EndpointRow({
	endpoint,
	stem,
	seconds,
	maxima,
	onSelect,
}: {
	endpoint: ServiceEndpoint
	stem: string
	seconds: number
	maxima: Maxima
	onSelect: (endpoint: ServiceEndpoint) => void
}) {
	const { head, tail } = leafLabel(endpoint.route, stem)
	return (
		<TableRow
			onClick={() => onSelect(endpoint)}
			className="group/row cursor-pointer border-b last:border-b-0 hover:bg-muted/40"
		>
			<TableCell className={cn("max-w-0 py-2 align-middle", stem.length > 0 ? "pl-6" : "pl-3")}>
				<div className="flex min-w-0 items-center gap-2.5">
					<MethodLabel method={endpoint.method} />
					<TruncatedText text={endpoint.route} mono className="text-[12.5px]">
						{head.length > 0 && <span className="text-muted-foreground/50">{head}</span>}
						<span className="text-foreground">{tail}</span>
					</TruncatedText>
				</div>
			</TableCell>
			<BarCell value={endpoint.estimatedSpanCount} max={maxima.calls} tone="calls">
				<SampledValue
					className="font-mono text-[12.5px] tabular-nums text-foreground"
					estimated={endpoint.estimatedSpanCount > endpoint.spanCount}
					value={formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds))}
				/>
			</BarCell>
			<BarCell
				value={endpoint.errorRate > 0 ? endpoint.errorRate : 0}
				// Fixed severity scale (5% = full bar), matching the Operations and
				// Dependencies tabs — a 0.2% sliver stays a sliver.
				max={0.05}
				tone="errors"
			>
				<ErrorRateValue rate={endpoint.errorRate} className="text-[12.5px]" />
			</BarCell>
			<TableCell className="py-2 text-right align-middle">
				<LatencyValue ms={endpoint.p50DurationMs} scale="p50" className="text-[12.5px]" />
			</TableCell>
			<BarCell value={endpoint.p95DurationMs} max={maxima.p95} tone="latency">
				<LatencyValue ms={endpoint.p95DurationMs} scale="p95" className="text-[12.5px]" />
			</BarCell>
			<TableCell className="py-2 pr-3 text-right align-middle">
				<LatencyValue ms={endpoint.p99DurationMs} scale="p95" className="text-[12.5px]" />
			</TableCell>
		</TableRow>
	)
}

function MethodLabel({ method }: { method: string }) {
	return (
		<span
			className={cn(
				"w-[52px] shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wide",
				methodTone(method),
			)}
		>
			{method}
		</span>
	)
}

function MobileGroup({
	group,
	seconds,
	expanded,
	onToggle,
	onSelect,
}: {
	group: EndpointGroup
	seconds: number
	expanded: boolean
	onToggle: () => void
	onSelect: (endpoint: ServiceEndpoint) => void
}) {
	const collapsed = group.kind === "unrouted" || group.kind === "probes"
	const title =
		group.kind === "unrouted" || group.kind === "probes" ? COLLAPSED_COPY[group.kind].label : group.stem
	const showRows = !collapsed || expanded
	return (
		<>
			{group.kind !== "ungrouped" && (
				<div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-mono text-xs font-medium",
							collapsed ? "text-muted-foreground" : "text-foreground",
						)}
					>
						{title}
					</span>
					<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
						{group.endpoints.length} ·{" "}
						{formatRate(callsPerSecond(group.totals.estimatedSpanCount, seconds))} req/s
					</span>
					{collapsed && (
						<Button
							variant="outline"
							size="sm"
							onClick={onToggle}
							className="h-6 shrink-0 px-2 text-[11px]"
						>
							{expanded ? "Hide" : "Show"}
						</Button>
					)}
				</div>
			)}
			{showRows
				? group.endpoints.map((endpoint) => {
						const { head, tail } = leafLabel(endpoint.route, collapsed ? "" : group.stem)
						return (
							<MobileListRow key={endpoint.spanName} onClick={() => onSelect(endpoint)}>
								<span className="flex min-w-0 items-center gap-2">
									<MethodLabel method={endpoint.method} />
									<span className="truncate font-mono text-[13px]">
										{head.length > 0 && (
											<span className="text-muted-foreground/50">{head}</span>
										)}
										<span className="text-foreground">{tail}</span>
									</span>
								</span>
								<MobileStatLine>
									<MobileStat label="req/s">
										<span className="text-foreground">
											{formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds))}
										</span>
									</MobileStat>
									<MobileStat label="err">
										<ErrorRateValue rate={endpoint.errorRate} />
									</MobileStat>
									<MobileStat label="p95">
										<LatencyValue ms={endpoint.p95DurationMs} scale="p95" />
									</MobileStat>
								</MobileStatLine>
							</MobileListRow>
						)
					})
				: null}
		</>
	)
}

/** Names which of the two conditions failed — a server span, and a route on it —
 *  rather than "no data", because the tab is empty for a reason the user can fix. */
function ApiEmptyState({ serviceName }: { serviceName: string }) {
	return (
		<div className="flex flex-col items-center gap-3.5 rounded-lg border bg-card px-[18px] py-11 text-center">
			<span className="font-mono text-[15px] font-medium text-foreground/90">
				No HTTP endpoints in this window
			</span>
			<span className="max-w-[620px] text-[13px] leading-[21px] text-muted-foreground">
				<span className="font-mono text-foreground/80">{serviceName}</span> reported spans in this
				range, but none are HTTP server spans with a route. An endpoint needs a server span carrying{" "}
				<span className="font-mono text-foreground/80">http.route</span> or{" "}
				<span className="font-mono text-foreground/80">url.path</span>.
			</span>
			<DocsLink page="otelConventions" />
		</div>
	)
}

/** Keeps the group/row rhythm so the table does not reflow when it resolves. */
function ApiLoadingState() {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-4 px-0.5">
				{[64, 56, 48, 72].map((w, i) => (
					<Skeleton key={i} className="h-3" style={{ width: w }} />
				))}
			</div>
			<div className={TABLE_CARD_CLASS}>
				<div className="flex items-center gap-3 border-b px-3 py-2.5">
					<Skeleton className="h-2.5 flex-1" />
					{[COLUMN.rate, COLUMN.err, COLUMN.p50, COLUMN.p95, COLUMN.p99].map((w, i) => (
						<div key={i} className={cn(w, "flex shrink-0 justify-end")}>
							<Skeleton className="h-2.5 w-8" />
						</div>
					))}
				</div>
				<SkeletonList
					rows={10}
					className="gap-0"
					renderRow={(i) => (
						<div
							className={cn(
								"flex items-center gap-3 border-b py-2.5 pr-3 last:border-b-0",
								i % 4 === 0 ? "bg-muted/30 pl-3" : "pl-6",
							)}
						>
							{i % 4 !== 0 && <Skeleton className="h-2.5 w-9 shrink-0" />}
							<Skeleton
								className={cn(
									"h-2.5",
									i % 3 === 0 ? "w-[220px]" : i % 3 === 1 ? "w-[150px]" : "w-[108px]",
								)}
							/>
							<span className="flex-1" />
							{[COLUMN.rate, COLUMN.err, COLUMN.p50, COLUMN.p95, COLUMN.p99].map((w, j) => (
								<div key={j} className={cn(w, "flex shrink-0 justify-end")}>
									<Skeleton className="h-2.5 w-10" />
								</div>
							))}
						</div>
					)}
				/>
			</div>
		</div>
	)
}
