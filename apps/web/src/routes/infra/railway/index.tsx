import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
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
import { DataTable } from "@/components/infra/primitives/data-table"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
import { ListToolbar, countLabel } from "@/components/infra/primitives/list-toolbar"
import {
	RailwayServiceTable,
	RailwayServiceTableLoading,
	RailwaySummaryBand,
	RailwaySummaryBandLoading,
	railwayInScope,
	type RailwayScope,
} from "@/components/infra/railway/railway-service-table"
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
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "unbounded"])),
	...TimeRangeSearchFields,
})

type RailwaySearchParams = Schema.Schema.Type<typeof railwaySearchSchema>

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

	const patchSearch = (patch: Partial<RailwaySearchParams>) => {
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
									.onInitial(() => (
										<RailwaySummaryBandLoading className={FLEET_BAND_BOXED} />
									))
									.onError((error) => <QueryErrorState error={error} />)
									.onSuccess((status) =>
										status.connected ? (
											<RailwayServices
												startTime={startTime}
												endTime={endTime}
												syncing={
													!status.authFailed && unsyncedEnvironments(status) > 0
												}
												query={search.q ?? ""}
												scope={search.scope}
												onQueryChange={(q) => patchSearch({ q: q || undefined })}
												onScopeChange={(scope) => patchSearch({ scope })}
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
	query,
	scope,
	onQueryChange,
	onScopeChange,
}: {
	startTime: string
	endTime: string
	syncing: boolean
	query: string
	scope: RailwayScope | undefined
	onQueryChange: (query: string) => void
	onScopeChange: (scope: RailwayScope | undefined) => void
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

	if (Result.isInitial(servicesResult)) {
		return (
			<div className="space-y-4">
				<RailwaySummaryBandLoading className={FLEET_BAND_BOXED} />
				<RailwayServiceTableLoading />
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

	const q = query.trim().toLowerCase()
	const filtered = services.filter(
		(row) =>
			(!scope || railwayInScope(row, scope)) &&
			(!q || `${row.serviceName} ${row.projectName} ${row.environmentName}`.toLowerCase().includes(q)),
	)

	return (
		<div className={cn("space-y-4 transition-opacity", servicesResult.waiting && "opacity-60")}>
			<RailwaySummaryBand
				services={services}
				activeScope={scope}
				onScopeChange={onScopeChange}
				className={FLEET_BAND_BOXED}
			/>
			<ListToolbar
				value={query}
				onChange={onQueryChange}
				placeholder="Search services…"
				trailing={
					filtered.length === services.length
						? countLabel(services.length, services.length, "service")
						: `${filtered.length} of ${services.length} services`
				}
			/>
			{filtered.length === 0 ? (
				<DataTable.Root ariaLabel="Railway services">
					<DataTable.Empty>
						No services match. Clear the search or scope to see them all.
					</DataTable.Empty>
				</DataTable.Root>
			) : (
				<RailwayServiceTable services={filtered} />
			)}
		</div>
	)
}

/** Stable empty fallback so memos don't recompute on every render. */
const NO_SERVICES: ReadonlyArray<RailwayServiceRow> = []
