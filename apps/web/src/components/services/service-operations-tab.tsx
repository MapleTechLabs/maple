import { useMemo } from "react"
import { Panel } from "@maple/ui/components/ui/panel"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { formatRate } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import {
	BarCell,
	HeadLabel,
	MobileListRow,
	MobileSortBar,
	MobileStat,
	MobileStatLine,
	SortColumnHead,
} from "./service-table-cells"
import { SampledValue } from "./sampled-value"
import { useTableSort } from "@/hooks/use-table-sort"
import { ErrorRateValue } from "@maple/ui/components/error-rate-value"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getServiceOperationsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ErrorState } from "@/components/common/error-state"
import type { ServiceOperation } from "@/api/warehouse/service-operations"
import {
	callsPerSecond,
	operationTraceSearch,
	serviceOperationsQueryInput,
	windowSeconds,
} from "./service-operations"
import { normalizeTimestampInput } from "@/lib/timezone-format"

interface ServiceOperationsTabProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Raw search params, forwarded to the /traces drill-down so relative presets stay live. */
	startTime?: string
	endTime?: string
	timePreset?: string
}

type SortKey = "estimatedSpanCount" | "errorRate" | "p50DurationMs" | "p95DurationMs"

export function ServiceOperationsTab({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
}: ServiceOperationsTabProps) {
	const navigate = useNavigate()

	const result = useRefreshableAtomValue(
		getServiceOperationsResultAtom({
			data: serviceOperationsQueryInput({
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
		? // See the note in service-api-tab: warehouse timestamps parse as local time.
			new Date(
				Date.parse(normalizeTimestampInput(effectiveEndTime)) - 30 * 24 * 60 * 60 * 1000,
			).toISOString()
		: startTime

	const operations = useMemo<ServiceOperation[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => [...r.operations])
				.orElse(() => []),
		[result],
	)

	const { sorted, sortKey, sortDir, handleSort } = useTableSort<ServiceOperation, SortKey>(operations, {
		initialKey: "estimatedSpanCount",
	})

	// Column-relative maxima drive the inline throughput/latency bars, mirroring
	// the Dependencies tab so both tables read as one system.
	const maxima = useMemo(
		() =>
			operations.reduce(
				(acc, op) => ({
					calls: Math.max(acc.calls, op.estimatedSpanCount),
					p95: Math.max(acc.p95, op.p95DurationMs),
				}),
				{ calls: 0, p95: 0 },
			),
		[operations],
	)

	const handleRowClick = (op: ServiceOperation) => {
		navigate({
			to: "/traces",
			search: operationTraceSearch({
				serviceName,
				spanName: op.spanName,
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
			.orElse(() => <OperationsLoadingState />)
	}

	const isWaiting = Result.isSuccess(result) && result.waiting

	return (
		<div
			className={cn("flex flex-col gap-2", refreshingClass(isWaiting))}
			aria-busy={isWaiting || undefined}
		>
			{traceDetailLimited && (
				<p className="text-xs text-muted-foreground">
					Operation summaries cover the selected range; individual trace drill-downs show the latest
					30 days.
				</p>
			)}
			{/* Desktop: dense sortable table with inline distribution bars. */}
			<Panel className="hidden md:block">
				<Table>
					<TableHeader>
						<TableRow className="border-b">
							<HeadLabel className="pl-3">Operation</HeadLabel>
							<SortColumnHead
								label="Calls /s"
								sortKey="estimatedSpanCount"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
							<SortColumnHead
								label="Errors"
								sortKey="errorRate"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
							<SortColumnHead
								label="p50"
								sortKey="p50DurationMs"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
							<SortColumnHead
								label="p95"
								sortKey="p95DurationMs"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
							<HeadLabel className="w-[140px] pr-3 text-right">Activity</HeadLabel>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.length === 0 ? (
							<TableRow>
								<TableCell colSpan={6} className="p-0">
									<EmptyMessage>No operations recorded in this window.</EmptyMessage>
								</TableCell>
							</TableRow>
						) : (
							sorted.map((op) => {
								return (
									<TableRow
										key={op.spanName}
										onClick={() => handleRowClick(op)}
										className="cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/40"
									>
										<TableCell className="max-w-0 py-2 pl-3 align-middle">
											<span
												className="block truncate font-mono text-xs text-foreground"
												title={op.spanName}
											>
												{op.spanName}
											</span>
										</TableCell>
										<BarCell
											value={op.estimatedSpanCount}
											max={maxima.calls}
											tone="calls"
										>
											<SampledValue
												className="tabular-nums font-mono text-xs text-foreground"
												estimated={op.estimatedSpanCount > op.spanCount}
												value={formatRate(
													callsPerSecond(op.estimatedSpanCount, seconds),
												)}
											/>
										</BarCell>
										<BarCell
											value={op.errorRate > 0 ? op.errorRate : 0}
											// Fixed severity scale (5% = full bar), matching the
											// Dependencies tab — a 0.2% sliver stays a sliver.
											max={0.05}
											tone="errors"
										>
											<ErrorRateValue rate={op.errorRate} className="text-xs" />
										</BarCell>
										<TableCell className="py-2 text-right align-middle">
											<LatencyValue
												ms={op.p50DurationMs}
												scale="p50"
												className="text-xs"
											/>
										</TableCell>
										<BarCell value={op.p95DurationMs} max={maxima.p95} tone="latency">
											<LatencyValue
												ms={op.p95DurationMs}
												scale="p95"
												className="text-xs"
											/>
										</BarCell>
										<TableCell className="py-1.5 pr-3 align-middle">
											<Sparkline
												data={op.sparkline.map((point) => ({ value: point.count }))}
												className="ml-auto h-6 w-[120px]"
											/>
										</TableCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>
			</Panel>

			{/* Mobile: tap-to-trace list with a compact sort control. */}
			<div className="space-y-2 md:hidden">
				<MobileSortBar
					options={
						[
							["estimatedSpanCount", "Calls"],
							["errorRate", "Errors"],
							["p95DurationMs", "p95"],
						] as const
					}
					sortKey={sortKey}
					sortDir={sortDir}
					onSort={handleSort}
				/>
				<Panel>
					{sorted.length === 0 ? (
						<EmptyMessage>No operations recorded in this window.</EmptyMessage>
					) : (
						sorted.map((op) => {
							return (
								<MobileListRow key={op.spanName} onClick={() => handleRowClick(op)}>
									<span className="truncate font-mono text-[13px] text-foreground">
										{op.spanName}
									</span>
									<MobileStatLine>
										<MobileStat label="calls">
											<SampledValue
												className="text-foreground"
												estimated={op.estimatedSpanCount > op.spanCount}
												value={formatRate(
													callsPerSecond(op.estimatedSpanCount, seconds),
												)}
											/>
										</MobileStat>
										<MobileStat label="err">
											<ErrorRateValue rate={op.errorRate} />
										</MobileStat>
										<MobileStat label="p95">
											<LatencyValue ms={op.p95DurationMs} scale="p95" />
										</MobileStat>
									</MobileStatLine>
								</MobileListRow>
							)
						})
					)}
				</Panel>
			</div>
		</div>
	)
}

function OperationsLoadingState() {
	return (
		<Panel>
			<SkeletonList
				rows={10}
				className="gap-0"
				renderRow={() => (
					<div className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
						<Skeleton className="h-3 flex-1" />
						<Skeleton className="h-3 w-12" />
						<Skeleton className="h-3 w-10" />
						<Skeleton className="h-3 w-12" />
						<Skeleton className="hidden h-5 w-[120px] md:block" />
					</div>
				)}
			/>
		</Panel>
	)
}
