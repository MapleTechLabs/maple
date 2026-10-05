import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorState } from "@/components/common/error-state"
import { DockerIcon, MagnifierIcon } from "@/components/icons"
import { PageHero } from "@/components/infra/primitives/page-hero"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
import { ListToolbar, countLabel } from "@/components/infra/primitives/list-toolbar"
import { HostsViewTabs } from "@/components/infra/hosts-view-tabs"
import { ContainerTable, ContainerTableLoading } from "@/components/infra/container-table"
import {
	ContainerSummaryBand,
	ContainerSummaryBandLoading,
	type ContainerScope,
} from "@/components/infra/container-summary-band"
import {
	ContainersFilterSidebarView,
	type ContainerFilters,
} from "@/components/infra/container-filter-sidebar"
import { InfraSetupEmpty } from "@/components/infra/infra-empty-state"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { containerFilterChips } from "@/lib/infra/container-filter-chips"
import {
	listContainersResultAtom,
	containerFacetsResultAtom,
	containersSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useDebouncedValue } from "@maple/ui/hooks/use-debounced-value"
import type { ContainerSortKey, SortDirection } from "@/api/warehouse/infra"

const PAGE_SIZE = 50

const ContainerSortKeyParam = Schema.optional(
	Schema.Literals(["saturation", "cpuPct", "memoryPct", "containerName", "lastSeen"]),
)
const SortDirParam = Schema.optional(Schema.Literals(["asc", "desc"]))
const ScopeParam = Schema.optional(Schema.Literals(["saturated", "elevated", "stale"]))

const containersSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: ScopeParam,
	sortBy: ContainerSortKeyParam,
	sortDir: SortDirParam,
	containerNames: OptionalStringArrayParam,
	hostNames: OptionalStringArrayParam,
	images: OptionalStringArrayParam,
	composeProjects: OptionalStringArrayParam,
	composeServices: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	excludedContainerNames: OptionalStringArrayParam,
	excludedHostNames: OptionalStringArrayParam,
	excludedImages: OptionalStringArrayParam,
	excludedComposeProjects: OptionalStringArrayParam,
	excludedComposeServices: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export type ContainersSearchParams = Schema.Schema.Type<typeof containersSearchSchema>

export const Route = createFileRoute("/infra/containers/")({
	component: ContainersPage,
	validateSearch: Schema.toStandardSchemaV1(containersSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const SCOPE_LABEL: Record<ContainerScope, string> = {
	saturated: "at or above 90% of CPU or its memory limit",
	elevated: "at or above 60% of CPU or its memory limit",
	stale: "whose agent has gone quiet",
} satisfies Record<ContainerScope, string>

function ContainersPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const filters: ContainerFilters = {
		containerNames: search.containerNames,
		hostNames: search.hostNames,
		images: search.images,
		composeProjects: search.composeProjects,
		composeServices: search.composeServices,
		environments: search.environments,
		excludedContainerNames: search.excludedContainerNames,
		excludedHostNames: search.excludedHostNames,
		excludedImages: search.excludedImages,
		excludedComposeProjects: search.excludedComposeProjects,
		excludedComposeServices: search.excludedComposeServices,
		excludedEnvironments: search.excludedEnvironments,
	}

	const sortBy: ContainerSortKey = search.sortBy ?? "saturation"
	const sortDir: SortDirection = search.sortDir ?? (sortBy === "containerName" ? "asc" : "desc")
	const scope = search.scope
	// The server filters by name, so typing must not fire a query per keystroke.
	const searchText = search.q ?? ""
	const debouncedSearch = useDebouncedValue(searchText, 300)

	const containersResult = useAtomValue(
		listContainersResultAtom({
			data: {
				startTime,
				endTime,
				...filters,
				search: debouncedSearch.trim() || undefined,
				scope,
				sortBy,
				sortDir,
				limit: PAGE_SIZE,
			},
		}),
	)

	// Scope-only: the band tells you how much of the fleet the filters above hid,
	// so narrowing it by those same filters would defeat the point.
	const summaryResult = useAtomValue(
		containersSummaryResultAtom({
			data: {
				startTime,
				endTime,
				hostNames: filters.hostNames,
				environments: filters.environments,
			},
		}),
	)

	const facetsResult = useAtomValue(
		containerFacetsResultAtom({
			data: {
				startTime,
				endTime,
			},
		}),
	)

	const patchSearch = (patch: Partial<ContainersSearchParams>) => {
		navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}

	const onFilterChange = <K extends keyof ContainerFilters>(key: K, value: ContainerFilters[K]) => {
		navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const onClearFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
			},
		})
	}

	// Clicking a header cycles desc → asc on the same key, and starts a new key at
	// the direction that puts the interesting rows first.
	const onSortChange = (key: ContainerSortKey) => {
		if (key === sortBy) {
			patchSearch({ sortDir: sortDir === "desc" ? "asc" : "desc" })
			return
		}
		patchSearch({ sortBy: key, sortDir: key === "containerName" ? "asc" : "desc" })
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

	const hasStructuredFilter = Object.values(filters).some((v) => (v?.length ?? 0) > 0)
	const hasAnyNarrowing = hasStructuredFilter || Boolean(searchText.trim()) || Boolean(scope)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Infrastructure", href: "/infra" }, { label: "Containers" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<ContainersFilterSidebarView
							facetsResult={facetsResult}
							filters={filters}
							onFilterChange={onFilterChange}
							onClearFilters={onClearFilters}
						/>
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								titleContent={<HostsViewTabs view="containers" timeSearch={search} />}
							>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? startTime}
									endTime={search.endTime ?? endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-6">
								<PageHero
									title="Containers"
									description="Sorted worst-first by peak utilization against each container's own limits."
								/>

								<ActiveFilterChips
									chips={containerFilterChips(search).map((chip) => ({
										id: chip.param,
										label: chip.label,
										values: chip.values,
										negated: chip.negated,
										onRemove: () =>
											navigate({
												search: (prev) => ({ ...prev, [chip.param]: undefined }),
											}),
									}))}
								/>

								{Result.builder(summaryResult)
									.onInitial(() => (
										<ContainerSummaryBandLoading className={FLEET_BAND_BOXED} />
									))
									.onError(() => null)
									.onSuccess((counts, result) => (
										<ContainerSummaryBand
											counts={counts}
											activeScope={scope}
											onScopeChange={(next) => patchSearch({ scope: next })}
											waiting={result.waiting}
											className={FLEET_BAND_BOXED}
										/>
									))
									.render()}

								{Result.builder(containersResult)
									.onInitial(() => <ContainerTableLoading />)
									.onError((err) => <ErrorState error={err} />)
									.onSuccess((response, result) => {
										const containers = response.data
										const total = response.totalCount

										if (containers.length === 0 && !hasAnyNarrowing) {
											return (
												<InfraSetupEmpty
													icon={<DockerIcon size={16} />}
													title="No containers reporting yet"
													description="Run the Maple Docker agent next to your containers to collect per-container CPU, memory, network, and block I/O. On Kubernetes, the Helm chart collects container metrics too."
													installTab="docker"
													actionLabel="Install the Docker agent"
													docs="docker"
												/>
											)
										}

										return (
											<div
												className={`space-y-4 transition-opacity ${
													result.waiting ? "opacity-60" : ""
												}`}
											>
												<ListToolbar
													value={searchText}
													onChange={(value) =>
														patchSearch({ q: value || undefined })
													}
													placeholder="Search all containers…"
													trailing={countLabel(
														containers.length,
														total,
														"container",
													)}
												/>

												{containers.length === 0 ? (
													<Empty className="py-12">
														<EmptyHeader>
															<EmptyMedia variant="icon">
																<MagnifierIcon size={16} />
															</EmptyMedia>
															<EmptyTitle>
																No containers match these filters
															</EmptyTitle>
															<EmptyDescription>
																{scope
																	? `Nothing is ${SCOPE_LABEL[scope]} in this window, which is good news.`
																	: "Try a different name, or clear the filters to see the whole fleet."}
															</EmptyDescription>
														</EmptyHeader>
														<Button
															variant="outline"
															size="sm"
															onClick={onClearFilters}
														>
															Clear all filters
														</Button>
													</Empty>
												) : (
													<ContainerTable
														containers={containers}
														sortBy={sortBy}
														sortDir={sortDir}
														onSortChange={onSortChange}
														waiting={result.waiting}
														referenceTime={endTime}
													/>
												)}
											</div>
										)
									})
									.render()}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
