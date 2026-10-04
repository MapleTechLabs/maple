import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MagnifierIcon, PlusIcon, ServerIcon, XmarkIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { FleetGrid } from "@/components/infra/fleet-grid"
import { HostTable, HostTableLoading, type HostRow } from "@/components/infra/host-table"
import { HostSummaryCards, HostSummaryCardsLoading } from "@/components/infra/host-summary-cards"
import { InfraIntegrations } from "@/components/infra/infra-integrations"
import { InfraSetupEmpty } from "@/components/infra/infra-empty-state"
import { InstallHostModal } from "@/components/infra/install-modal"
import { deriveHostStatus, type HostStatus } from "@/components/infra/format"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { listHostsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

export const Route = createFileRoute("/infra/")({
	component: InfraPage,
})

const FLEET_GRID_THRESHOLD = 4

type StatusFilter = "all" | HostStatus

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active" },
	{ value: "idle", label: "Idle" },
	{ value: "ended", label: "Ended" },
]

function InfraPage() {
	const [installOpen, setInstallOpen] = useState(false)
	const [search, setSearch] = useState("")
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "12h")

	const hostsResult = useAtomValue(
		listHostsResultAtom({
			data: {
				startTime,
				endTime,
			},
		}),
	)

	// With no hosts, the connected providers are what this org actually has, so they lead the page
	// instead of sitting under a "No hosts reporting yet" block that reads as "nothing connected".
	const sourcesFirst = Result.builder(hostsResult)
		.onSuccess((response) => response.data.length === 0)
		.orElse(() => false)

	const heroActions = (
		<Button size="sm" onClick={() => setInstallOpen(true)}>
			<PlusIcon size={14} />
			Add host
		</Button>
	)

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Infrastructure" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="space-y-6">
							<PageHero
								title="Infrastructure"
								description="Hosts, containers, Kubernetes nodes and connected providers reporting to Maple."
								actions={heroActions}
							/>

							{sourcesFirst && <InfraIntegrations />}

							{Result.builder(hostsResult)
								.onInitial(() => (
									<div className="space-y-6">
										<HostSummaryCardsLoading />
										<HostTableLoading />
									</div>
								))
								.onError((err) => <QueryErrorState error={err} />)
								.onSuccess((response, result) => {
									const hosts = response.data

									if (hosts.length === 0 && !search.trim()) {
										return (
											<InfraSetupEmpty
												icon={<ServerIcon size={16} />}
												title="No hosts reporting yet"
												description="Hosts lists every machine sending CPU, memory, disk and network metrics. Run the OpenTelemetry Collector with the hostmetrics receiver on a host, or install the Helm chart to report every Kubernetes node."
												installTab="hosts"
												actionLabel="Add host"
												docs="hosts"
											>
												<Link
													to="/infra/discover"
													className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
												>
													See all collectors
												</Link>
											</InfraSetupEmpty>
										)
									}

									return (
										<FleetView
											hosts={hosts}
											waiting={Boolean(result.waiting)}
											startTime={startTime}
											endTime={endTime}
											search={search}
											onSearchChange={setSearch}
											statusFilter={statusFilter}
											onStatusFilterChange={setStatusFilter}
										/>
									)
								})
								.render()}

							{!sourcesFirst && <InfraIntegrations />}
						</div>

						<InstallHostModal
							open={installOpen}
							onOpenChange={setInstallOpen}
							defaultTab="hosts"
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

interface FleetViewProps {
	hosts: ReadonlyArray<HostRow>
	waiting: boolean
	startTime: string
	endTime: string
	search: string
	onSearchChange: (v: string) => void
	statusFilter: StatusFilter
	onStatusFilterChange: (v: StatusFilter) => void
}

function FleetView({
	hosts,
	waiting,
	startTime,
	endTime,
	search,
	onSearchChange,
	statusFilter,
	onStatusFilterChange,
}: FleetViewProps) {
	const annotated = useMemo(
		() => hosts.map((h) => ({ host: h, status: deriveHostStatus(h.lastSeen) })),
		[hosts],
	)

	const counts = useMemo(() => {
		const c: Record<HostStatus, number> = { active: 0, idle: 0, ended: 0 } satisfies Record<
			HostStatus,
			number
		>
		for (const a of annotated) c[a.status]++
		return c
	}, [annotated])

	const q = search.trim().toLowerCase()
	const filtered = useMemo(() => {
		const byStatus =
			statusFilter === "all"
				? hosts
				: annotated.filter((a) => a.status === statusFilter).map((a) => a.host)
		return q ? byStatus.filter((h) => h.hostName.toLowerCase().includes(q)) : byStatus
	}, [hosts, annotated, statusFilter, q])

	const showFleetGrid = hosts.length >= FLEET_GRID_THRESHOLD

	return (
		<div className={cn("transition-opacity", waiting && "opacity-60")}>
			<div className="space-y-4">
				<HostSummaryCards hosts={hosts} startTime={startTime} endTime={endTime} />
				{showFleetGrid && <FleetGrid hosts={hosts} />}
			</div>

			<div className="mt-8 space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<InputGroup className="w-64">
						<InputGroupAddon>
							<MagnifierIcon />
						</InputGroupAddon>
						<InputGroupInput
							size="sm"
							placeholder="Search hosts…"
							value={search}
							onChange={(e) => onSearchChange(e.target.value)}
						/>
						{search && (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									aria-label="Clear search"
									onClick={() => onSearchChange("")}
								>
									<XmarkIcon />
								</InputGroupButton>
							</InputGroupAddon>
						)}
					</InputGroup>
					<div
						role="tablist"
						aria-label="Filter hosts by status"
						className="flex items-center gap-0.5 rounded-md border bg-background p-0.5"
					>
						{STATUS_FILTERS.map((opt) => {
							const count = opt.value === "all" ? hosts.length : (counts[opt.value] ?? 0)
							const active = statusFilter === opt.value
							return (
								<button
									key={opt.value}
									type="button"
									role="tab"
									aria-selected={active}
									onClick={() => onStatusFilterChange(opt.value)}
									className={cn(
										"inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors",
										active
											? "bg-foreground text-background"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{opt.label}
									<span
										className={cn(
											"tabular-nums",
											active ? "text-background/70" : "text-foreground/40",
										)}
									>
										{count}
									</span>
								</button>
							)
						})}
					</div>
				</div>

				{q && filtered.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MagnifierIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No hosts match “{search}”</EmptyTitle>
							<EmptyDescription>
								Try a different name, or clear the search to see all hosts.
							</EmptyDescription>
						</EmptyHeader>
						<Button variant="outline" size="sm" onClick={() => onSearchChange("")}>
							Clear search
						</Button>
					</Empty>
				) : statusFilter !== "all" && filtered.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ServerIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No hosts with this status in this window.</EmptyTitle>
							<EmptyDescription>
								Active hosts reported in the last minute, idle ones in the last 5 minutes,
								ended ones longer ago.
							</EmptyDescription>
						</EmptyHeader>
						<Button variant="outline" size="sm" onClick={() => onStatusFilterChange("all")}>
							Show all hosts
						</Button>
					</Empty>
				) : (
					<HostTable hosts={filtered} waiting={waiting} />
				)}
			</div>
		</div>
	)
}
