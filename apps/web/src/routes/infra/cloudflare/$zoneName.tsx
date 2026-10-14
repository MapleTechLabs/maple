import { useMemo } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { ResultView } from "@/components/common/result-view"
import { cn } from "@maple/ui/lib/utils"
import { Result } from "@/lib/effect-atom"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { CloudflareIcon } from "@/components/icons"
import { HeroChip, PageHero } from "@/components/common/page-hero"
import { CloudflareBreakdownPanel } from "@/components/infra/cloudflare/cloudflare-breakdown-panel"
import {
	CloudflareIngestEmpty,
	CloudflareStalledAction,
} from "@/components/infra/cloudflare/cloudflare-ingest-status"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import { CloudflareFilterChips } from "@/components/infra/cloudflare/cloudflare-filter-chips"
import { CloudflareFilterPopover } from "@/components/infra/cloudflare/cloudflare-filter-popover"
import {
	CloudflareZoneSignals,
	zoneSeverityClass,
} from "@/components/infra/cloudflare/cloudflare-zone-signals"
import { CloudflareZoneRail, type ZoneRailDns } from "@/components/infra/cloudflare/cloudflare-zone-rail"
import { CloudflareZoneDnsSection } from "@/components/infra/cloudflare/cloudflare-zone-dns"
import { CloudflareZoneSecuritySection } from "@/components/infra/cloudflare/cloudflare-zone-security"
import { zoneSignalTotals } from "@/components/infra/cloudflare/zone-signals"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import {
	cloudflareFilterSearchFields,
	filtersFromSearch,
	toggleFilterValue,
	type ActiveFilterChip,
	type CloudflareFilterKey,
	type CloudflareFilters,
} from "@/components/infra/cloudflare/filters"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	cloudflareZoneDetailResultAtom,
	cloudflareZoneDnsResultAtom,
	cloudflareZoneFacetsResultAtom,
	cloudflareZoneSecurityResultAtom,
	cloudflareZonesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

const ZONE_TABS = ["traffic", "dns", "security"] as const
type ZoneTab = (typeof ZONE_TABS)[number]

const zoneDetailSearchSchema = Schema.Struct({
	...cloudflareFilterSearchFields,
	...TimeRangeSearchFields,
	tab: Schema.optional(Schema.Literals(ZONE_TABS)),
})

export const Route = createFileRoute("/infra/cloudflare/$zoneName")({
	component: ZoneDetailPage,
	validateSearch: Schema.toStandardSchemaV1(zoneDetailSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const ZONE_SERVICE_PREFIX = "cloudflare/"

function ZoneDetailPage() {
	const { zoneName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)
	const serviceName = `${ZONE_SERVICE_PREFIX}${zoneName}`
	const filters = filtersFromSearch(search)
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const tab: ZoneTab = search.tab ?? "traffic"

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	// Empty selections drop out of the URL entirely rather than lingering as `?paths=[]`.
	const onFilterChange = <K extends keyof CloudflareFilters>(key: K, value: CloudflareFilters[K]) => {
		navigate({
			search: (prev) => ({
				...prev,
				[key]:
					value === undefined || (Array.isArray(value) && value.length === 0) ? undefined : value,
			}),
		})
	}

	const onToggleFilter = (key: CloudflareFilterKey, value: string) => {
		if (key === "pathContains") return
		navigate({ search: (prev) => ({ ...prev, [key]: toggleFilterValue(filters[key], value) }) })
	}

	const onRemoveChip = (chip: ActiveFilterChip) => {
		if (chip.key === "pathContains") {
			navigate({ search: (prev) => ({ ...prev, pathContains: undefined }) })
			return
		}
		onToggleFilter(chip.key, chip.value)
	}

	const onClearFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				tab: search.tab,
			},
		})
	}

	const onTabChange = (next: ZoneTab) => {
		navigate({
			replace: true,
			search: (prev) => ({ ...prev, tab: next === "traffic" ? undefined : next }),
		})
	}

	const detailInput = { serviceName, startTime, endTime, bucketSeconds, ...filters }
	// Retained: the filters are part of the atom keys, so a bare read would flash skeletons on every toggle.
	const facetsResult = useRefreshableAtomValue(
		cloudflareZoneFacetsResultAtom({ data: { serviceName, startTime, endTime, ...filters } }),
	)
	const detailResult = useRefreshableAtomValue(cloudflareZoneDetailResultAtom({ data: detailInput }))
	const dnsResult = useRefreshableAtomValue(cloudflareZoneDnsResultAtom({ data: detailInput }))
	const securityResult = useRefreshableAtomValue(cloudflareZoneSecurityResultAtom({ data: detailInput }))
	// The list rollup carries bytes/visits/latency; picking this zone's row shares its cached atom.
	const zonesResult = useRefreshableAtomValue(
		cloudflareZonesResultAtom({ data: { startTime, endTime, ...filters } }),
	)
	const zoneRow = Result.builder(zonesResult)
		.onSuccess((r) => r.zones.find((zone) => zone.serviceName === serviceName) ?? null)
		.orElse(() => null)

	const { statusResult, phase } = useCloudflareIngestPhase()
	const zoneAccount = Result.builder(statusResult)
		.onSuccess((status) => {
			const accounts = status.accounts ?? []
			const account = accounts.find((a) => a.zones.some((zone) => zone.name === zoneName))
			if (account === undefined) return null
			return {
				id: account.accountId,
				name: account.accountName ?? account.accountId,
				multi: accounts.length > 1,
				zoneError: account.zones.find((zone) => zone.name === zoneName)?.lastError ?? null,
			}
		})
		.orElse(() => null)
	const accountName = zoneAccount?.name ?? null

	const dns = Result.builder(dnsResult)
		.onSuccess((data): ZoneRailDns | null =>
			data.names.length === 0 && data.buckets.length === 0
				? null
				: {
						queries: data.buckets.reduce((acc, b) => acc + b.queries, 0),
						alwaysNxdomain: data.names.filter((n) => n.queries > 0 && n.nxdomain >= n.queries)
							.length,
					},
		)
		.orElse(() => null)
	const firewallEvents = Result.builder(securityResult)
		.onSuccess((data) => data.buckets.reduce((acc, b) => acc + b.events, 0))
		.orElse(() => null)

	const tabs = useMemo(
		() => [
			{ value: "traffic" as const, label: "Traffic" },
			...(dns === null ? [] : [{ value: "dns" as const, label: "DNS" }]),
			...(firewallEvents === null || firewallEvents === 0
				? []
				: [{ value: "security" as const, label: "Security" }]),
		],
		[dns, firewallEvents],
	)

	const severity = Result.builder(detailResult)
		.onSuccess((detail) => zoneSeverityClass(zoneSignalTotals(detail.statusBuckets, detail.cacheBuckets)))
		.orElse(() => null)

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Cloudflare", href: "/infra/cloudflare" },
				{ label: zoneName },
			]}
			time={{ search, startTime, endTime, defaultPreset: "12h", onChange: handleTimeChange }}
			rightPanel={
				<CloudflareZoneRail
					serviceName={serviceName}
					accountName={accountName}
					zoneRow={zoneRow}
					dns={dns}
					firewallEvents={firewallEvents}
					onOpenTab={onTabChange}
				/>
			}
			gap="lg"
		>
			<PageHero
				title={
					<span className="flex items-center gap-3">
						{severity === null ? null : (
							<span aria-hidden className={cn("size-2 shrink-0 rounded-full", severity)} />
						)}
						{zoneName}
					</span>
				}
				actions={
					tabs.length > 1 ? (
						<SegmentPivot<ZoneTab>
							ariaLabel="Zone view"
							options={tabs}
							value={tabs.some((t) => t.value === tab) ? tab : "traffic"}
							onChange={onTabChange}
						/>
					) : null
				}
				meta={
					<>
						<HeroChip>zone</HeroChip>
						{zoneAccount === null ? null : zoneAccount.multi ? (
							<Link to="/infra/cloudflare" search={{ account: zoneAccount.id }}>
								<HeroChip>account {zoneAccount.name}</HeroChip>
							</Link>
						) : (
							<HeroChip>account {zoneAccount.name}</HeroChip>
						)}
						<CloudflareFilterChips
							filters={filters}
							onRemove={onRemoveChip}
							onClear={onClearFilters}
						/>
						<CloudflareFilterPopover
							facetsResult={facetsResult}
							filters={filters}
							onFilterChange={onFilterChange}
							onClearFilters={onClearFilters}
						/>
					</>
				}
			/>
			{zoneAccount?.zoneError ? (
				<div className="rounded-md bg-severity-error/10 px-3 py-2 text-xs text-foreground">
					This zone isn't syncing ({zoneAccount.zoneError}). The strips stop at its last sync; the
					gap is missing data, not quiet traffic.
				</div>
			) : null}
			{tab === "dns" && dns !== null ? (
				<CloudflareZoneDnsSection
					serviceName={serviceName}
					startTime={startTime}
					endTime={endTime}
					bucketSeconds={bucketSeconds}
					filters={filters}
				/>
			) : tab === "security" && firewallEvents !== null && firewallEvents > 0 ? (
				<CloudflareZoneSecuritySection
					serviceName={serviceName}
					startTime={startTime}
					endTime={endTime}
					bucketSeconds={bucketSeconds}
					filters={filters}
				/>
			) : (
				<ResultView
					result={detailResult}
					loading={
						<div className="space-y-6">
							<Skeleton className="h-80 w-full" />
							<Skeleton className="h-64 w-full" />
						</div>
					}
				>
					{(detail, { waiting }) => {
						if (detail.statusBuckets.length === 0 && !waiting) {
							// Before any data is collected, "this zone has no traffic" would be the wrong thing to say.
							if (phase != null && phase.kind !== "live" && phase.kind !== "backfilling") {
								return (
									<CloudflareIngestEmpty phase={phase}>
										{phase.kind === "stalled" ? <CloudflareStalledAction /> : null}
									</CloudflareIngestEmpty>
								)
							}
							return <ZoneEmpty />
						}
						return (
							<div className="space-y-6">
								<CloudflareZoneSignals
									statusBuckets={detail.statusBuckets}
									cacheBuckets={detail.cacheBuckets}
									latencyBuckets={detail.latencyBuckets}
									zoneRow={zoneRow}
									ignoredFilters={detail.ignoredFilters}
									latencyIgnoredFilters={detail.latencyIgnoredFilters}
									waiting={waiting}
								/>
								<CloudflareBreakdownPanel
									serviceName={serviceName}
									zoneName={zoneName}
									startTime={startTime}
									endTime={endTime}
									bucketSeconds={bucketSeconds}
									filters={filters}
									onToggleFilter={onToggleFilter}
								/>
							</div>
						)
					}}
				</ResultView>
			)}
		</DashboardPage>
	)
}

function ZoneEmpty() {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CloudflareIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>No traffic for this zone in the selected window</EmptyTitle>
				<EmptyDescription>
					Widen the time range, clear the filters, or check the zone list for where traffic is
					landing.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyActions>
				<Button variant="outline" size="sm" render={<Link to="/infra/cloudflare" />}>
					Back to zones
				</Button>
				<DocsLink page="cloudflare" />
			</EmptyActions>
		</Empty>
	)
}
