import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Result } from "@/lib/effect-atom"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { DocsLink } from "@/components/common/docs-link"
import { ResultView } from "@/components/common/result-view"
import { CloudflareIcon } from "@/components/icons"
import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import {
	CloudflareIngestBanner,
	CloudflareIngestEmpty,
	CloudflareStalledAction,
} from "@/components/infra/cloudflare/cloudflare-ingest-status"
import { CloudflareNotConnected } from "@/components/infra/cloudflare/cloudflare-not-connected"
import { cloudflareAccounts } from "@/components/infra/cloudflare/accounts"
import { CloudflareListPage } from "@/components/infra/cloudflare/cloudflare-list-page"
import { CloudflareBandLoading } from "@/components/infra/cloudflare/cloudflare-summary-bands"
import {
	CLOUDFLARE_VIEWS,
	mergeWorkerRows,
	WORKER_SCOPES,
	ZONE_SCOPES,
} from "@/components/infra/cloudflare/list-model"
import type { CloudflareIngestPhase } from "@/components/infra/cloudflare/ingest-phase"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	cloudflarePlatformResourcesResultAtom,
	cloudflareWorkersResultAtom,
	cloudflareZonesResultAtom,
	cloudflareZoneTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"

const cloudflareSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
	view: Schema.optional(Schema.Literals(CLOUDFLARE_VIEWS)),
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals([...ZONE_SCOPES, ...WORKER_SCOPES])),
	previews: Schema.optional(Schema.Boolean),
	/** One account of a multi-account grant; absent means all of them. */
	account: Schema.optional(Schema.String),
})

type CloudflareSearch = Schema.Schema.Type<typeof cloudflareSearchSchema>

export const Route = createFileRoute("/infra/cloudflare/")({
	component: CloudflarePage,
	validateSearch: Schema.toStandardSchemaV1(cloudflareSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

function CloudflarePage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}
	const patchSearch = (patch: Partial<CloudflareSearch>) => {
		navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) })
	}

	// Integration-gated: the page is useful once Cloudflare is connected with analytics scopes. The
	// hook also carries the ingest phase and polls while a fresh connection is filling up.
	const { statusResult, phase } = useCloudflareIngestPhase()

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure", href: "/infra" }, { label: "Cloudflare" }]}
			time={{ search, startTime, endTime, defaultPreset: "12h", onChange: handleTimeChange }}
			gap="lg"
		>
			<ResultView
				result={statusResult}
				loading={
					<div className="space-y-4">
						<Skeleton className="h-8 w-48" />
						<CloudflareBandLoading className={FLEET_BAND_BOXED} />
					</div>
				}
			>
				{(status) => {
					if (!status.connected) return <CloudflareNotConnected variant="not-connected" />
					if (!status.analyticsCapable)
						return <CloudflareNotConnected variant="needs-permissions" />
					return (
						<CloudflareData
							status={status}
							startTime={startTime}
							endTime={endTime}
							phase={phase}
							search={search}
							onSearchChange={patchSearch}
						/>
					)
				}}
			</ResultView>
		</DashboardPage>
	)
}

function CloudflareData({
	status,
	startTime,
	endTime,
	phase,
	search,
	onSearchChange,
}: {
	status: CloudflareIntegrationStatus
	startTime: string
	endTime: string
	phase: CloudflareIngestPhase | null
	search: CloudflareSearch
	onSearchChange: (patch: Partial<CloudflareSearch>) => void
}) {
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	// Retained so a refresh or a time-range nudge fades the current numbers instead of skeletons.
	const zonesResult = useRefreshableAtomValue(cloudflareZonesResultAtom({ data: { startTime, endTime } }))
	const timeseriesResult = useRefreshableAtomValue(
		cloudflareZoneTimeseriesResultAtom({ data: { startTime, endTime, bucketSeconds } }),
	)
	const workersResult = useRefreshableAtomValue(
		cloudflareWorkersResultAtom({ data: { startTime, endTime } }),
	)
	const platformResult = useRefreshableAtomValue(
		cloudflarePlatformResourcesResultAtom({ data: { startTime, endTime } }),
	)

	// Ticks so "synced 2m ago" ages and a stalled account turns Delayed while the page stays open.
	const now = useLiveClock({ intervalMs: 60_000 })
	const accounts = useMemo(() => cloudflareAccounts(status.accounts ?? [], now), [status, now])

	const zones = Result.builder(zonesResult)
		.onSuccess((r) => r.zones)
		.orElse(() => null)
	const sparks = Result.builder(timeseriesResult)
		.onSuccess((r) => requestSparks(r.buckets))
		.orElse(() => undefined)
	const platform = Result.builder(platformResult)
		.onSuccess((r) => r)
		.orElse(() => null)
	const workerRows = Result.builder(workersResult)
		.onSuccess((r) => mergeWorkerRows(r.workers, platform?.durableObjects ?? []))
		.orElse(() => null)

	if (zones?.length === 0 && workerRows?.length === 0 && platform?.queues.length === 0) {
		// A connection that has never produced anything says why; a quiet window offers a wider one.
		if (phase != null && phase.kind !== "live" && phase.kind !== "backfilling") {
			return (
				<CloudflareIngestEmpty phase={phase}>
					{phase.kind === "stalled" ? <CloudflareStalledAction /> : null}
				</CloudflareIngestEmpty>
			)
		}
		return <NoTraffic />
	}

	return (
		<CloudflareListPage
			accounts={accounts}
			singleAccountName={status.accountName ?? null}
			zones={zones}
			sparks={sparks}
			workerRows={workerRows}
			queues={platform?.queues ?? null}
			waiting={{
				zones: zonesResult.waiting,
				workers: workersResult.waiting,
				queues: platformResult.waiting,
			}}
			banner={phase == null ? null : <CloudflareIngestBanner phase={phase} />}
			state={search}
			onStateChange={onSearchChange}
		/>
	)
}

/** Requests per bucket per zone, in bucket order, for the row sparklines. */
function requestSparks(
	buckets: ReadonlyArray<{ serviceName: string; bucket: string; requests: number }>,
): ReadonlyMap<string, ReadonlyArray<number>> {
	const byZone = new Map<string, Array<{ bucket: string; requests: number }>>()
	for (const row of buckets) {
		const series = byZone.get(row.serviceName) ?? []
		series.push(row)
		byZone.set(row.serviceName, series)
	}
	return new Map(
		[...byZone].map(([serviceName, series]) => [
			serviceName,
			series.toSorted((a, b) => a.bucket.localeCompare(b.bucket)).map((point) => point.requests),
		]),
	)
}

function NoTraffic() {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CloudflareIcon size={16} />
				</EmptyMedia>
				<EmptyTitle>No Cloudflare traffic in this window</EmptyTitle>
				<EmptyDescription>
					No zone, Worker or queue reported anything over the selected range. Widen the time range,
					or check back once more traffic has been collected.
				</EmptyDescription>
			</EmptyHeader>
			<DocsLink page="cloudflare" />
		</Empty>
	)
}
