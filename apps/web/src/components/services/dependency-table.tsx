import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import {
	BarCell,
	HeadLabel,
	MobileListRow,
	MobileSortBar,
	SortableHead,
	errorTone,
	formatErrorRate,
	formatRate,
	type SortDir,
} from "./service-table-cells"
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

type SortKey = "calls" | "errorRate" | "p95"

export function DependencyTable({ serviceName, rows, startTime, endTime, timePreset }: DependencyTableProps) {
	const navigate = useNavigate()
	const [sortKey, setSortKey] = useState<SortKey>("calls")
	const [sortDir, setSortDir] = useState<SortDir>("desc")

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

	const sorted = useMemo(() => {
		const out = [...rows]
		out.sort((a, b) => {
			const aV =
				sortKey === "calls" ? a.callsPerSec : sortKey === "errorRate" ? a.errorRate : a.p95DurationMs
			const bV =
				sortKey === "calls" ? b.callsPerSec : sortKey === "errorRate" ? b.errorRate : b.p95DurationMs
			return sortDir === "desc" ? bV - aV : aV - bV
		})
		return out
	}, [rows, sortKey, sortDir])

	const toggleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir(sortDir === "desc" ? "asc" : "desc")
		} else {
			setSortKey(key)
			setSortDir("desc")
		}
	}

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
			<div className="hidden overflow-hidden rounded-lg border bg-card md:block">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent border-b">
							<HeadLabel className="pl-3">Target</HeadLabel>
							<SortableHead
								label="Calls /s"
								align="right"
								active={sortKey === "calls"}
								dir={sortDir}
								onClick={() => toggleSort("calls")}
							/>
							<SortableHead
								label="Errors"
								align="right"
								active={sortKey === "errorRate"}
								dir={sortDir}
								onClick={() => toggleSort("errorRate")}
							/>
							<HeadLabel className="text-right">Avg</HeadLabel>
							<SortableHead
								label="p95"
								align="right"
								active={sortKey === "p95"}
								dir={sortDir}
								onClick={() => toggleSort("p95")}
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
								const tone = errorTone(row.errorRate)
								return (
									<TableRow
										key={row.id}
										onClick={() => handleRowClick(row)}
										className="cursor-pointer group/row border-b last:border-b-0 hover:bg-muted/40"
									>
										<TableCell className="py-2 pl-3 align-middle">
											<div className="flex items-center gap-2.5 min-w-0">
												<DependencyTypeBadge kind={row.kind} />
												<div className="flex min-w-0 flex-col leading-tight">
													<span className="flex items-center gap-1.5 truncate text-[12.5px] text-foreground">
														{row.kind === "service" && (
															<ServiceDot
																serviceName={row.name}
																className="size-1.5"
															/>
														)}
														<span className="truncate">{row.name}</span>
													</span>
													{row.subtitle ? (
														<span className="truncate text-[10px] text-muted-foreground/60">
															{row.subtitle}
														</span>
													) : null}
												</div>
											</div>
										</TableCell>
										<BarCell value={row.callsPerSec} max={maxima.calls} tone="calls">
											{row.hasSampling ? (
												<Tooltip>
													<TooltipTrigger
														render={<span />}
														className="cursor-help tabular-nums font-mono text-[12.5px] text-foreground"
													>
														~{formatRate(row.callsPerSec)}
													</TooltipTrigger>
													<TooltipContent>
														Estimated ×{row.samplingWeight.toFixed(0)} from{" "}
														{formatRate(row.tracedCallsPerSec)} traced req/s
													</TooltipContent>
												</Tooltip>
											) : (
												<span className="tabular-nums font-mono text-[12.5px] text-foreground">
													{formatRate(row.callsPerSec)}
												</span>
											)}
										</BarCell>
										<BarCell
											value={row.errorRate > 0 ? row.errorRate : 0}
											// Errors get a fixed "severity scale" (5% = full bar) rather
											// than column-relative, so a 0.2% sliver looks small even
											// when it happens to be the worst in the table.
											max={0.05}
											tone="errors"
										>
											<span
												className={cn(
													"tabular-nums font-mono text-[12.5px]",
													tone === "error" && "text-severity-error",
													tone === "warn" && "text-severity-warn",
													tone === "default" && "text-muted-foreground/80",
												)}
											>
												{formatErrorRate(row.errorRate)}
											</span>
										</BarCell>
										<TableCell className="py-2 text-right align-middle">
											<LatencyValue
												ms={row.avgDurationMs}
												scale="avg"
												className="text-[12.5px]"
											/>
										</TableCell>
										<BarCell value={row.p95DurationMs} max={maxima.p95} tone="latency">
											<LatencyValue
												ms={row.p95DurationMs}
												scale="p95"
												className="text-[12.5px]"
											/>
										</BarCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>
			</div>

			{/* Mobile: tap-to-trace list with a compact sort control. The 5-column
			    table clips below md, so each row collapses to name + a mono metric line. */}
			<div className="space-y-2 md:hidden">
				<MobileSortBar
					options={
						[
							["calls", "Calls"],
							["errorRate", "Errors"],
							["p95", "p95"],
						] as const
					}
					sortKey={sortKey}
					sortDir={sortDir}
					onSort={toggleSort}
				/>
				<div className="overflow-hidden rounded-lg border bg-card">
					{sorted.length === 0 ? (
						<EmptyMessage>
							No downstream dependencies in this window.
							<span className="mt-1 block text-muted-foreground/70">
								Outgoing calls show up when client spans carry peer.service or server.address.
							</span>
						</EmptyMessage>
					) : (
						sorted.map((row) => {
							const tone = errorTone(row.errorRate)
							return (
								<MobileListRow key={row.id} onClick={() => handleRowClick(row)}>
									<div className="flex min-w-0 items-center gap-2.5">
										<DependencyTypeBadge kind={row.kind} />
										<div className="flex min-w-0 flex-col leading-tight">
											<span className="truncate text-[13px] text-foreground">
												{row.name}
											</span>
											{row.subtitle ? (
												<span className="truncate text-[10px] text-muted-foreground/60">
													{row.subtitle}
												</span>
											) : null}
										</div>
									</div>
									<div className="flex items-center gap-3 font-mono text-xs tabular-nums">
										<span>
											<span className="text-muted-foreground/60">calls </span>
											<span className="text-foreground">
												{row.hasSampling ? "~" : ""}
												{formatRate(row.callsPerSec)}
											</span>
										</span>
										<span>
											<span className="text-muted-foreground/60">err </span>
											<span
												className={cn(
													tone === "error" && "text-severity-error",
													tone === "warn" && "text-severity-warn",
													tone === "default" && "text-muted-foreground/80",
												)}
											>
												{formatErrorRate(row.errorRate)}
											</span>
										</span>
										<span>
											<span className="text-muted-foreground/60">p95 </span>
											<LatencyValue ms={row.p95DurationMs} scale="p95" />
										</span>
									</div>
								</MobileListRow>
							)
						})
					)}
				</div>
			</div>
		</>
	)
}
