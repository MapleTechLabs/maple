import { FilteredEmpty } from "@/components/common/filtered-empty"
import { useMemo, useState } from "react"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { useAtomValue } from "@/lib/effect-atom"

import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { MagnifierIcon, PlusIcon, ServerIcon } from "@/components/icons"
import { ResultView } from "@/components/common/result-view"
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
import { SearchToolbar, countLabel } from "@/components/common/search-toolbar"
import { PageHero } from "@/components/common/page-hero"
import { listHostsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

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

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "Hosts" }]}
			titleContent={<HostsViewTabs view="hosts" timeSearch={search} />}
			time={{ search, startTime, endTime, defaultPreset: DEFAULT_PRESET, onChange: handleTimeChange }}
			gap="lg"
		>
			<PageHero
				title="Hosts"
				description="Every machine sending CPU, memory, disk and network metrics, busiest first."
				actions={
					<Button size="sm" variant="outline" onClick={() => setInstallOpen(true)}>
						<PlusIcon size={14} />
						Add host
					</Button>
				}
			/>

			<ResultView
				result={hostsResult}
				loading={
					<div className="space-y-6">
						<HostSummaryBandLoading className={FLEET_BAND_BOXED} />
						<HostTableLoading />
					</div>
				}
				isEmpty={(response) => response.data.length === 0}
				empty={
					<InfraSetupEmpty
						icon={<ServerIcon size={16} />}
						title="No hosts reporting yet"
						description="Run the OpenTelemetry Collector with the hostmetrics receiver on a host, or install the Helm chart to report every Kubernetes node."
						installTab="hosts"
						actionLabel="Add host"
						docs="hosts"
					/>
				}
			>
				{(response, { waiting }) => (
					<HostList
						hosts={response.data}
						waiting={waiting}
						referenceTime={endTime}
						query={search.q ?? ""}
						scope={search.scope}
						onQueryChange={(q) => patchSearch({ q: q || undefined })}
						onScopeChange={(scope) => patchSearch({ scope })}
						onClear={() => patchSearch({ q: undefined, scope: undefined })}
					/>
				)}
			</ResultView>

			<InstallHostModal open={installOpen} onOpenChange={setInstallOpen} defaultTab="hosts" />
		</DashboardPage>
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
		<div className={cn("space-y-4", refreshingClass(waiting))} aria-busy={waiting || undefined}>
			<HostSummaryBand
				hosts={hosts}
				referenceTime={referenceTime}
				activeScope={scope}
				onScopeChange={onScopeChange}
				className={FLEET_BAND_BOXED}
			/>
			<SearchToolbar
				value={query}
				onChange={onQueryChange}
				placeholder="Search hosts…"
				trailing={
					hosts.length >= HOST_LIST_LIMIT
						? `${formatNumber(filtered.length)} of the ${formatNumber(HOST_LIST_LIMIT)} most recently seen hosts`
						: filtered.length === hosts.length
							? countLabel(hosts.length, hosts.length, "host")
							: `${filtered.length} of ${hosts.length} hosts`
				}
			/>
			{filtered.length === 0 ? (
				<FilteredEmpty
					noun="hosts"
					className="py-12"
					icon={<MagnifierIcon size={16} />}
					title="No hosts match"
					description="Try a different name, or clear the search and scope to see every host."
					onClear={onClear}
					clearLabel="Clear"
				/>
			) : (
				<HostTable hosts={filtered} waiting={waiting} />
			)}
		</div>
	)
}
