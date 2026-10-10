import { useMemo } from "react"
import { Panel } from "@maple/ui/components/ui/panel"
import { useNavigate } from "@tanstack/react-router"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { formatRate } from "@maple/ui/lib/format"
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
import { DependencyTypeBadge, type DependencyKind } from "./dependency-type-badge"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { LatencyValue } from "@maple/ui/components/latency-value"

export interface DependencyRow {
	id: string
	kind: DependencyKind
	name: string
	subtitle?: string
	callsPerSec: number
	tracedCallsPerSec: number
	totalCalls: number
	estimatedCalls: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
	whereClause: string
}

interface DependencyTableProps {
	serviceName: string
	rows: DependencyRow[]
	startTime?: string
	endTime?: string
	timePreset?: string
}

type SortKey = "callsPerSec" | "errorRate" | "p95DurationMs"

export function DependencyTable({ serviceName, rows, startTime, endTime, timePreset }: DependencyTableProps) {
	const navigate = useNavigate()

	// Column-relative maxima drive the inline bars. Calls + p95 read as "more is
	// more"; error rate as "any value is a problem", so its bar always tints red
	// with intensity scaled to severity (0..5%+).
	const maxima = useMemo(() => {
		return rows.reduce(
			(acc, row) => ({
				calls: Math.max(acc.calls, row.callsPerSec),
				p95: Math.max(acc.p95, row.p95DurationMs),
			}),
			{ calls: 0, p95: 0 },
		)
	}, [rows])

	const { sorted, sortKey, sortDir, handleSort } = useTableSort<DependencyRow, SortKey>(rows, {
		initialKey: "callsPerSec",
	})

	const handleRowClick = (row: DependencyRow) => {
		navigate({
			to: "/traces",
			search: {
				services: [serviceName],
				whereClause: row.whereClause,
				startTime,
				endTime,
				timePreset,
			},
		})
	}

	return (
		<>
			{/* Desktop: dense sortable table with inline distribution bars. */}
			<Panel className="hidden md:block">
				<Table>
					<TableHeader>
						<TableRow className="border-b">
							<HeadLabel className="pl-3">Target</HeadLabel>
							<SortColumnHead
								label="Calls /s"
								sortKey="callsPerSec"
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
							<HeadLabel className="text-right">Avg</HeadLabel>
							<SortColumnHead
								label="p95"
								sortKey="p95DurationMs"
								activeKey={sortKey}
								dir={sortDir}
								onSort={handleSort}
							/>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.length === 0 ? (
							<TableRow>
								<TableCell colSpan={5} className="p-0">
									<EmptyMessage>
										No downstream dependencies in this window.
										<span className="mt-1 block text-muted-foreground/70">
											Outgoing calls show up when client spans carry peer.service or
											server.address.
										</span>
									</EmptyMessage>
								</TableCell>
							</TableRow>
						) : (
							sorted.map((row) => {
								return (
									<TableRow
										key={row.id}
										tabIndex={0}
										onClick={() => handleRowClick(row)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault()
												handleRowClick(row)
											}
										}}
										className="cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
									>
										<TableCell className="max-w-0 py-2 pl-3 align-middle">
											<div className="flex items-center gap-2.5 min-w-0">
												<DependencyTypeBadge kind={row.kind} />
												<div className="flex min-w-0 flex-col leading-tight">
													<span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
														{row.kind === "service" && (
															<ServiceDot serviceName={row.name} size="sm" />
														)}
														<span className="truncate" title={row.name}>
															{row.name}
														</span>
													</span>
													{row.subtitle ? (
														<span className="truncate text-3xs text-muted-foreground/60">
															{row.subtitle}
														</span>
													) : null}
												</div>
											</div>
										</TableCell>
										<BarCell value={row.callsPerSec} max={maxima.calls} tone="calls">
											<SampledValue
												className="tabular-nums font-mono text-xs text-foreground"
												estimated={row.hasSampling}
												value={formatRate(row.callsPerSec)}
												tooltip={`Estimated ×${row.samplingWeight.toFixed(0)} from ${formatRate(row.tracedCallsPerSec)} traced req/s`}
											/>
										</BarCell>
										<BarCell
											value={row.errorRate > 0 ? row.errorRate : 0}
											// Errors get a fixed "severity scale" (5% = full bar) rather
											// than column-relative, so a 0.2% sliver looks small even
											// when it happens to be the worst in the table.
											max={0.05}
											tone="errors"
										>
											<ErrorRateValue rate={row.errorRate} className="text-xs" />
										</BarCell>
										<TableCell className="py-2 text-right align-middle">
											<LatencyValue
												ms={row.avgDurationMs}
												scale="avg"
												className="text-xs"
											/>
										</TableCell>
										<BarCell value={row.p95DurationMs} max={maxima.p95} tone="latency">
											<LatencyValue
												ms={row.p95DurationMs}
												scale="p95"
												className="text-xs"
											/>
										</BarCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>
			</Panel>

			{/* Mobile: tap-to-trace list with a compact sort control. The 5-column
			    table clips below md, so each row collapses to name + a mono metric line. */}
			<div className="space-y-2 md:hidden">
				<MobileSortBar
					options={
						[
							["callsPerSec", "Calls"],
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
						<EmptyMessage>
							No downstream dependencies in this window.
							<span className="mt-1 block text-muted-foreground/70">
								Outgoing calls show up when client spans carry peer.service or server.address.
							</span>
						</EmptyMessage>
					) : (
						sorted.map((row) => {
							return (
								<MobileListRow key={row.id} onClick={() => handleRowClick(row)}>
									<div className="flex min-w-0 items-center gap-2.5">
										<DependencyTypeBadge kind={row.kind} />
										<div className="flex min-w-0 flex-col leading-tight">
											<span className="truncate text-[13px] text-foreground">
												{row.name}
											</span>
											{row.subtitle ? (
												<span className="truncate text-3xs text-muted-foreground/60">
													{row.subtitle}
												</span>
											) : null}
										</div>
									</div>
									<MobileStatLine>
										<MobileStat label="calls">
											<SampledValue
												className="text-foreground"
												estimated={row.hasSampling}
												value={formatRate(row.callsPerSec)}
											/>
										</MobileStat>
										<MobileStat label="err">
											<ErrorRateValue rate={row.errorRate} />
										</MobileStat>
										<MobileStat label="p95">
											<LatencyValue ms={row.p95DurationMs} scale="p95" />
										</MobileStat>
									</MobileStatLine>
								</MobileListRow>
							)
						})
					)}
				</Panel>
			</div>
		</>
	)
}
