import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { cn } from "@maple/ui/lib/utils"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MagnifierIcon, PlusIcon, ServerIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { HostTable, HostTableLoading, type HostRow } from "@/components/infra/host-table"
import {
	HOST_LIST_LIMIT,
	HostSummaryBand,
	HostSummaryBandLoading,
	hostInScope,
} from "@/components/infra/host-summary-band"
import { HostsViewTabs } from "@/components/infra/hosts-view-tabs"
import { InfraSetupEmpty } from "@/components/infra/infra-empty-state"
import { InstallHostModal } from "@/components/infra/install-modal"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
import { ListToolbar, countLabel } from "@/components/infra/primitives/list-toolbar"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { listHostsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const DEFAULT_PRESET = "12h"

const hostsSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	...TimeRangeSearchFields,
})

type HostsSearchParams = Schema.Schema.Type<typeof hostsSearchSchema>

export const Route = createFileRoute("/infra/hosts/")({
	component: HostsPage,
	validateSearch: Schema.toStandardSchemaV1(hostsSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function HostsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const [installOpen, setInstallOpen] = useState(false)

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)

	const hostsResult = useAtomValue(
		listHostsResultAtom({ data: { startTime, endTime, limit: HOST_LIST_LIMIT } }),
	)

	const patchSearch = (patch: Partial<HostsSearchParams>) => {
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

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
					items={[{ label: "Infrastructure", href: "/infra" }, { label: "Hosts" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								titleContent={<HostsViewTabs view="hosts" timeSearch={search} />}
							>
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
									title="Hosts"
									description="Every machine sending CPU, memory, disk and network metrics, busiest first."
									actions={
										<Button
											size="sm"
											variant="outline"
											onClick={() => setInstallOpen(true)}
										>
											<PlusIcon size={14} />
											Add host
										</Button>
									}
								/>

								{Result.builder(hostsResult)
									.onInitial(() => (
										<div className="space-y-6">
											<HostSummaryBandLoading className={FLEET_BAND_BOXED} />
											<HostTableLoading />
										</div>
									))
									.onError((err) => <ErrorState error={err} />)
									.onSuccess((response, result) => {
										const hosts = response.data
										if (hosts.length === 0) {
											return (
												<InfraSetupEmpty
													icon={<ServerIcon size={16} />}
													title="No hosts reporting yet"
													description="Run the OpenTelemetry Collector with the hostmetrics receiver on a host, or install the Helm chart to report every Kubernetes node."
													installTab="hosts"
													actionLabel="Add host"
													docs="hosts"
												/>
											)
										}
										return (
											<HostList
												hosts={hosts}
												waiting={Boolean(result.waiting)}
												referenceTime={endTime}
												query={search.q ?? ""}
												scope={search.scope}
												onQueryChange={(q) => patchSearch({ q: q || undefined })}
												onScopeChange={(scope) => patchSearch({ scope })}
												onClear={() =>
													patchSearch({ q: undefined, scope: undefined })
												}
											/>
										)
									})
									.render()}
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
		</PageRefreshProvider>
	)
}

function HostList({
	hosts,
	waiting,
	referenceTime,
	query,
	scope,
	onQueryChange,
	onScopeChange,
	onClear,
}: {
	hosts: ReadonlyArray<HostRow>
	waiting: boolean
	referenceTime: string
	query: string
	scope: HostsSearchParams["scope"]
	onQueryChange: (q: string) => void
	onScopeChange: (scope: HostsSearchParams["scope"]) => void
	onClear: () => void
}) {
	const q = query.trim().toLowerCase()
	const filtered = useMemo(
		() =>
			hosts.filter(
				(host) =>
					(!scope || hostInScope(host, scope, referenceTime)) &&
					(!q || host.hostName.toLowerCase().includes(q)),
			),
		[hosts, scope, q, referenceTime],
	)

	return (
		<div className={cn("space-y-4 transition-opacity", waiting && "opacity-60")}>
			<HostSummaryBand
				hosts={hosts}
				referenceTime={referenceTime}
				activeScope={scope}
				onScopeChange={onScopeChange}
				className={FLEET_BAND_BOXED}
			/>
			<ListToolbar
				value={query}
				onChange={onQueryChange}
				placeholder="Search hosts…"
				trailing={
					hosts.length >= HOST_LIST_LIMIT
						? `${filtered.length.toLocaleString()} of the ${HOST_LIST_LIMIT.toLocaleString()} most recently seen hosts`
						: filtered.length === hosts.length
							? countLabel(hosts.length, hosts.length, "host")
							: `${filtered.length} of ${hosts.length} hosts`
				}
			/>
			{filtered.length === 0 ? (
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<MagnifierIcon size={16} />
						</EmptyMedia>
						<EmptyTitle>No hosts match</EmptyTitle>
						<EmptyDescription>
							Try a different name, or clear the search and scope to see every host.
						</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" onClick={onClear}>
						Clear
					</Button>
				</Empty>
			) : (
				<HostTable hosts={filtered} waiting={waiting} />
			)}
		</div>
	)
}
