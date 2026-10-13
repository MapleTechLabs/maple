import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { TableSkeleton } from "@maple/ui/components/ui/table-skeleton"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { formatNumber, formatRate, pluralize } from "@maple/ui/lib/format"
import { Panel } from "@maple/ui/components/ui/panel"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getReleasesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { ErrorState } from "@/components/common/error-state"
import { DocsLink } from "@/components/common/docs-link"
import {
	TimeRangeSearchFields,
	applyTimeRangeSearch,
	pickTimeRangeSearch,
} from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"
import { ReleasesFilterSidebar } from "@/components/releases/releases-filter-sidebar"
import { RELEASES_DEFAULT_PRESET, releasesQueryInput } from "@/components/releases/releases-query-input"
import { ReleasesTimeline } from "@/components/releases/releases-timeline"
import { ReleasesTable } from "@/components/releases/releases-table"
import { ReleasesLiveNow } from "@/components/releases/releases-live-now"
import { useReleaseIssueCounts } from "@/components/releases/use-release-issue-counts"
import {
	deriveReleaseImpacts,
	groupReleases,
	liveVersions,
	type ReleaseGroup,
	type ReleaseServiceImpact,
	type ReleaseHealth,
} from "@/components/releases/release-model"
import { RELEASE_HEALTH_LABEL } from "@/components/releases/release-health"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const DEFAULT_PRESET = RELEASES_DEFAULT_PRESET

const releasesSearchSchema = Schema.Struct({
	environments: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	// Render-only: the health band is derived client-side from the same rows,
	// so it never reaches the atom input.
	// The literals are spelled out rather than imported from the model: the
	// search schema lives in the route shell (startup code), and importing
	// the model here would pull it into every page's first load.
	impact: Schema.optional(
		Schema.Literals(["regressed", "watch", "rolling", "healthy"] satisfies ReleaseHealth[]),
	),
	...TimeRangeSearchFields,
})

export type ReleasesSearchParams = Schema.Schema.Type<typeof releasesSearchSchema>

// No hover-preload loader on purpose: loaders stay in the route shell (see
// vite.config's code-splitting order), and the whole web app pays for every
// shell at startup. The 650 KB budget had 1.6 KB of headroom; this page's
// contract and atoms take 1.3 of it, and a loader would take the rest.
export const Route = createFileRoute("/releases/")({
	component: ReleasesPage,
	validateSearch: Schema.toStandardSchemaV1(releasesSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware({ maxRangeSeconds: ONE_YEAR_SECONDS })] },
})

function ReleasesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? DEFAULT_PRESET,
	)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
		})
	}

	const chips = [
		...(search.excludedEnvironments?.length
			? [
					{
						id: "excludedEnvironments",
						label: "Environment",
						values: search.excludedEnvironments,
						negated: true,
					},
				]
			: []),
		...(search.environments?.length
			? [{ id: "environments", label: "Environment", values: search.environments, negated: false }]
			: []),
		...(search.services?.length
			? [{ id: "services", label: "Service", values: search.services, negated: false }]
			: []),
		...(search.impact !== undefined
			? [
					{
						id: "impact",
						label: "Health",
						values: [RELEASE_HEALTH_LABEL[search.impact]],
						negated: false,
					},
				]
			: []),
	].map((chip) => ({
		...chip,
		onRemove: () => navigate({ search: (prev) => ({ ...prev, [chip.id]: undefined }) }),
	}))

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Releases" }]}
			time={{
				search,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				defaultPreset: DEFAULT_PRESET,
				onChange: handleTimeChange,
				presets: LONG_RANGE_PRESET_OPTIONS,
				maxRangeSeconds: ONE_YEAR_SECONDS,
			}}
			filters={<ReleasesFilterSidebar />}
		>
			<ActiveFilterChips chips={chips} />
			<ReleasesContent search={search} />
		</DashboardPage>
	)
}

function ReleasesSkeleton() {
	return (
		<div className="flex flex-col gap-3">
			<Skeleton className="h-4 w-64" />
			<Skeleton className="h-52 w-full rounded-md" />
			<TableSkeleton
				rows={8}
				columns={[
					{ header: "Release", headClassName: "w-[46%] min-w-[260px]", skeleton: "w-48" },
					{ header: "Services" },
					{ header: "Deployed", headClassName: "whitespace-nowrap" },
					{ header: "Error rate", headClassName: "whitespace-nowrap", skeleton: "w-12" },
					{ header: "p95", skeleton: "w-12" },
					{ header: "Issues", skeleton: "w-8" },
				]}
			/>
		</div>
	)
}

function ReleasesContent({ search }: { search: ReleasesSearchParams }) {
	const navigate = useNavigate({ from: Route.fullPath })
	const atom = getReleasesResultAtom({ data: releasesQueryInput(search) })
	const result = useRefreshableAtomValue(atom)
	const refresh = useAtomRefresh(atom)

	const derived = useMemo(() => {
		if (!Result.isSuccess(result)) return undefined
		const impacts = deriveReleaseImpacts(result.value.releases, result.value.timeline)
		const groups = groupReleases(impacts)
		const live = liveVersions(result.value.timeline, groups)
		return { impacts, groups, live, response: result.value }
	}, [result])

	if (Result.isFailure(result)) {
		return <ErrorState error={result.cause} title="Failed to load releases" onRetry={refresh} />
	}
	if (derived === undefined) return <ReleasesSkeleton />

	const { impacts, groups, live, response } = derived
	const health: ReleaseHealth | undefined = search.impact
	const visibleGroups = health === undefined ? groups : groups.filter((group) => group.health === health)
	const visibleImpacts =
		health === undefined ? impacts : impacts.filter((impact) => impact.health === health)
	const services = new Set(impacts.map((impact) => impact.serviceName)).size
	const windowDays = Math.max(
		1 / 24,
		(Date.parse(response.endTime) - Date.parse(response.startTime)) / 86_400_000,
	)
	const flagged = groups.filter((group) => group.health === "regressed").length
	const timeSearch = pickTimeRangeSearch(search)
	const waiting = Result.isSuccess(result) && result.waiting

	if (groups.length === 0) {
		return (
			<Panel>
				<EmptyMessage className="flex flex-col items-center gap-1 py-12 text-sm">
					<span>No releases detected in this window.</span>
					<span className="text-xs text-muted-foreground/70">
						Releases compare errors and latency before and after each deploy. Release tracking
						needs spans to carry the <InlineCode>vcs.ref.head.revision</InlineCode> resource
						attribute.
					</span>
					<span className="mt-2">
						<DocsLink page="github" />
					</span>
				</EmptyMessage>
			</Panel>
		)
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-0.5 text-xs text-muted-foreground">
				<span>
					<span className="font-medium tabular-nums text-foreground">
						{formatNumber(groups.length)}
					</span>{" "}
					{pluralize(groups.length, "release")}
				</span>
				<span>
					<span className="font-medium tabular-nums text-foreground">{formatNumber(services)}</span>{" "}
					{pluralize(services, "service")}
				</span>
				<span>
					<span className="font-medium tabular-nums text-foreground">
						{formatRate(groups.length / windowDays)}
					</span>{" "}
					per day
				</span>
				{flagged > 0 ? (
					<span>
						<span className="font-medium tabular-nums text-severity-error">
							{formatNumber(flagged)}
						</span>{" "}
						{pluralize(flagged, "release")} with errors up
					</span>
				) : null}
				<span className="text-muted-foreground/70">
					Each release is compared with the version it replaced
				</span>
				{response.truncated ? (
					<span className="text-muted-foreground/70">
						Showing the newest {formatNumber(response.releases.length)} rows
					</span>
				) : null}
			</div>
			<ReleasesLiveNow live={live} timeSearch={timeSearch} environments={search.environments} />
			<ReleasesTimeline
				impacts={visibleImpacts}
				startTime={response.startTime}
				endTime={response.endTime}
				timeSearch={timeSearch}
				environments={search.environments}
			/>
			{visibleGroups.length === 0 ? (
				<Panel>
					<EmptyMessage className="flex flex-col items-center gap-3 text-sm">
						No releases match the health filter.
						<Button
							variant="outline"
							size="sm"
							onClick={() => navigate({ search: (prev) => ({ ...prev, impact: undefined }) })}
						>
							Clear filter
						</Button>
					</EmptyMessage>
				</Panel>
			) : (
				<ReleasesTableWithIssues
					groups={visibleGroups}
					impacts={impacts}
					windowStart={response.startTime}
					timeSearch={timeSearch}
					environments={search.environments}
					waiting={waiting}
				/>
			)}
		</div>
	)
}

function ReleasesTableWithIssues({
	impacts,
	windowStart,
	...props
}: {
	groups: ReadonlyArray<ReleaseGroup>
	impacts: ReadonlyArray<ReleaseServiceImpact>
	windowStart: string
	timeSearch: ReturnType<typeof pickTimeRangeSearch>
	environments?: string[]
	waiting: boolean
}) {
	const { counts, capped } = useReleaseIssueCounts(impacts, windowStart)
	return (
		<div className="flex flex-col gap-1.5">
			<ReleasesTable {...props} issueCounts={counts} />
			{capped ? (
				<span className="px-0.5 text-2xs text-muted-foreground/70">
					Issue counts cover the 100 most recently active issues introduced in this window.
				</span>
			) : null}
		</div>
	)
}
