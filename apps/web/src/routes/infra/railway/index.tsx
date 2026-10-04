import { useMemo } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatBytes } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { EmptyActions } from "@/components/common/docs-link"
import { QueryErrorState } from "@/components/common/query-error-state"
import { RailwayIcon } from "@/components/icons"
import {
	RailwayIntegrationCard,
	railwayStatusAtom,
	unsyncedEnvironments,
} from "@/components/integrations/railway-integration-card"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { formatCores, shareOfLimit } from "@/components/infra/railway/format"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { railwayServicesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { RailwayServiceRow } from "@/api/warehouse/railway-infra"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const railwaySearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/infra/railway/")({
	component: RailwayPage,
	validateSearch: Schema.toStandardSchemaV1(railwaySearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const DEFAULT_PRESET = "6h"

function RailwayPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)
	const statusResult = useAtomValue(railwayStatusAtom)

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Infrastructure", href: "/infra" }, { label: "Railway" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={
										search.timePreset ?? (search.startTime ? undefined : DEFAULT_PRESET)
									}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title="Railway"
									description="CPU, memory, network and disk for every Railway service, polled from Railway's metrics API."
								/>
								{Result.builder(statusResult)
									.onInitial(() => <StatRailLoading />)
									.onError((error) => <QueryErrorState error={error} />)
									.onSuccess((status) =>
										status.connected ? (
											<RailwayServices
												startTime={startTime}
												endTime={endTime}
												syncing={
													!status.authFailed && unsyncedEnvironments(status) > 0
												}
											/>
										) : (
											<RailwayIntegrationCard />
										),
									)
									.render()}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

/** Re-reads while the page is empty, so a just-connected account fills in without a reload. */
const EMPTY_REFRESH_MS = 15_000

function RailwayServices({
	startTime,
	endTime,
	syncing,
}: {
	startTime: string
	endTime: string
	syncing: boolean
}) {
	const servicesAtom = railwayServicesResultAtom({ data: { startTime, endTime } })
	const servicesResult = useRefreshableAtomValue(servicesAtom)
	const refreshServices = useAtomRefresh(servicesAtom)
	const refreshStatus = useAtomRefresh(railwayStatusAtom)
	const services = Result.builder(servicesResult)
		.onSuccess((response) => response.services)
		.orElse(() => NO_SERVICES)
	const empty = Result.isSuccess(servicesResult) && services.length === 0
	useIntervalRefresh(refreshServices, { intervalMs: EMPTY_REFRESH_MS, enabled: empty })
	useIntervalRefresh(refreshStatus, { intervalMs: EMPTY_REFRESH_MS, enabled: empty && syncing })

	const totals = useMemo(() => {
		let cpu = 0
		let memory = 0
		let replicas = 0
		for (const row of services) {
			cpu += row.cpuAvg
			memory += row.memoryAvg
			replicas += row.replicas
		}
		return { cpu, memory, replicas }
	}, [services])

	if (Result.isInitial(servicesResult)) {
		return (
			<div className="space-y-4">
				<StatRailLoading />
				<Skeleton className="h-48 w-full rounded-md" />
			</div>
		)
	}
	if (Result.isFailure(servicesResult) && services.length === 0) {
		return <QueryErrorState error={servicesResult.cause} />
	}
	if (services.length === 0) {
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<RailwayIcon size={16} />
					</EmptyMedia>
					<EmptyTitle>
						{syncing ? "Pulling your Railway metrics" : "No Railway metrics in this time range"}
					</EmptyTitle>
					<EmptyDescription>
						{syncing
							? "Some environments haven't finished their first sync. This page updates on its own as they land."
							: "Services that ran in this window show up here. Try a wider time range, or check the connection for errors."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyActions>
					<Button
						variant="outline"
						size="sm"
						render={<Link to="/integrations" search={{ integration: "railway" }} />}
					>
						Check the connection
					</Button>
				</EmptyActions>
			</Empty>
		)
	}

	return (
		<div className={cn("space-y-6 transition-opacity", servicesResult.waiting && "opacity-60")}>
			<StatRail>
				<StatRailItem compact eyebrow="Services" value={String(services.length)} />
				<StatRailItem compact eyebrow="Replicas" value={String(totals.replicas)} />
				<StatRailItem compact eyebrow="Avg CPU in use" value={formatCores(totals.cpu)} />
				<StatRailItem compact eyebrow="Avg memory in use" value={formatBytes(totals.memory)} />
			</StatRail>
			<RailwayServiceTable services={services} />
		</div>
	)
}

function UsageCell({
	value,
	limit,
	format,
}: {
	value: number
	limit: number
	format: (v: number) => string
}) {
	const share = shareOfLimit(value, limit)
	return (
		<div className="flex flex-col items-end gap-1">
			<span className="font-mono text-xs tabular-nums">
				{format(value)}
				{limit > 0 ? <span className="text-muted-foreground"> / {format(limit)}</span> : null}
			</span>
			{share !== null ? (
				<span className="h-1 w-24 overflow-hidden rounded-full bg-muted">
					<span
						className={cn(
							"block h-full rounded-full",
							share >= 90 ? "bg-severity-error" : share >= 75 ? "bg-warning" : "bg-primary",
						)}
						style={{ width: `${Math.min(100, Math.max(share, 1))}%` }}
					/>
				</span>
			) : null}
		</div>
	)
}

function RailwayServiceTable({ services }: { services: ReadonlyArray<RailwayServiceRow> }) {
	return (
		<div className="overflow-x-auto rounded-md border bg-card">
			<table className="w-full min-w-[640px] text-sm">
				<thead>
					<tr className="border-b text-[11px] font-medium text-muted-foreground">
						<th className="px-3 py-2 text-left font-medium">Service</th>
						<th className="px-3 py-2 text-right font-medium">CPU (avg / limit)</th>
						<th className="px-3 py-2 text-right font-medium">Memory (avg / limit)</th>
						<th className="px-3 py-2 text-right font-medium">Replicas</th>
					</tr>
				</thead>
				<tbody>
					{services.map((row) => (
						<tr
							key={`${row.environmentId}:${row.serviceId}`}
							className="border-b last:border-b-0 hover:bg-muted/40"
						>
							<td className="px-3 py-2.5">
								<Link
									to="/infra/railway/$serviceId"
									params={{ serviceId: row.serviceId }}
									search={{ environmentId: row.environmentId }}
									className="flex min-w-0 flex-col hover:underline"
								>
									<span className="truncate font-medium">
										{row.serviceName || row.serviceId}
									</span>
									<span className="truncate text-xs text-muted-foreground">
										{row.projectName} / {row.environmentName}
									</span>
								</Link>
							</td>
							<td className="px-3 py-2.5">
								<UsageCell value={row.cpuAvg} limit={row.cpuLimit} format={formatCores} />
							</td>
							<td className="px-3 py-2.5">
								<UsageCell
									value={row.memoryAvg}
									limit={row.memoryLimit}
									format={formatBytes}
								/>
							</td>
							<td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
								{row.replicas}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

/** Stable empty fallback so memos don't recompute on every render. */
const NO_SERVICES: ReadonlyArray<RailwayServiceRow> = []
