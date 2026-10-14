import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { Result } from "@/lib/effect-atom"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { ResultView } from "@/components/common/result-view"
import {
	CloudflareTraceGapCallout,
	CloudflareWorkerHeader,
	CloudflareWorkerOutcomes,
	CloudflareWorkerRail,
	CloudflareWorkerSignals,
} from "@/components/infra/cloudflare/cloudflare-worker-page"
import { mergeWorkerRows } from "@/components/infra/cloudflare/list-model"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import {
	deployMarkers,
	untracedExceptions,
	workerOutcomeTotals,
} from "@/components/infra/cloudflare/worker-signals"
import { chartBucketSeconds } from "@/components/infra/chart-utils"
import {
	cloudflarePlatformResourcesResultAtom,
	cloudflareWorkerDetailResultAtom,
	cloudflareWorkersResultAtom,
	getReleasesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { sessionTimeRangeSearchMiddleware } from "@/components/time-range-picker/session-time-range"
import { toIsoBucket } from "@/api/warehouse/timeseries-utils"

const workerSearchSchema = Schema.Struct({
	...TimeRangeSearchFields,
	/** Pins the account when the same script name runs in several. */
	account: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/infra/cloudflare/workers/$scriptName")({
	component: WorkerDetailPage,
	validateSearch: Schema.toStandardSchemaV1(workerSearchSchema),
	search: { middlewares: [sessionTimeRangeSearchMiddleware()] },
})

const WORKER_SERVICE_PREFIX = "cloudflare-worker/"

function WorkerDetailPage() {
	const { scriptName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)
	const bucketSeconds = chartBucketSeconds(startTime, endTime)
	const serviceName = `${WORKER_SERVICE_PREFIX}${scriptName}`

	const handleTimeChange = (range: TimeRange, options?: { replace?: boolean }) => {
		navigate({
			replace: options?.replace,
			search: (prev) => ({ ...applyTimeRangeSearch(prev, range) }),
		})
	}

	const detailResult = useRefreshableAtomValue(
		cloudflareWorkerDetailResultAtom({
			data: { serviceName, startTime, endTime, bucketSeconds, accountId: search.account },
		}),
	)
	// The list rollups carry the window's p99s and DO totals; this Worker's row shares their cached atoms.
	const workersResult = useRefreshableAtomValue(
		cloudflareWorkersResultAtom({ data: { startTime, endTime } }),
	)
	const platformResult = useRefreshableAtomValue(
		cloudflarePlatformResourcesResultAtom({ data: { startTime, endTime } }),
	)
	// Workers report spans under their script name; the service map matches them the same way.
	const releasesResult = useRefreshableAtomValue(
		getReleasesResultAtom({ data: { startTime, endTime, services: [scriptName] } }),
	)
	const { statusResult } = useCloudflareIngestPhase()

	const row = Result.builder(workersResult)
		.onSuccess((r) => {
			const durableObjects = Result.builder(platformResult)
				.onSuccess((p) => p.durableObjects)
				.orElse(() => [])
			return (
				mergeWorkerRows(r.workers, durableObjects).find(
					(w) =>
						w.scriptName === scriptName &&
						(search.account === undefined || w.accountId === search.account),
				) ?? null
			)
		})
		.orElse(() => null)
	// Releases carry no account, so for a name shared across accounts they would mix both Workers.
	const releases = Result.builder(releasesResult)
		.onSuccess((r) =>
			row?.nameInOtherAccounts
				? null
				: r.releases.filter((release) => release.serviceName === scriptName),
		)
		.orElse(() => null)
	const accountName = Result.builder(statusResult)
		.onSuccess((status) => {
			const accounts = status.accounts ?? []
			const accountId = row?.accountId ?? search.account
			return accounts.length > 1
				? (accounts.find((a) => a.accountId === accountId)?.accountName ?? null)
				: (status.accountName ?? null)
		})
		.orElse(() => null)

	const traced =
		releases === null || releases.length === 0
			? null
			: {
					service: scriptName,
					spans: releases.reduce((acc, r) => acc + r.spanCount, 0),
					errors: releases.reduce((acc, r) => acc + r.errorCount, 0),
				}
	const markers = useMemo(
		() => deployMarkers(releases ?? [], toIsoBucket(startTime), bucketSeconds),
		[releases, startTime, bucketSeconds],
	)
	const currentVersion =
		releases === null || releases.length === 0
			? null
			: (releases.toSorted((a, b) => b.firstSeen.localeCompare(a.firstSeen))[0]?.commitSha ?? null)

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure", href: "/infra" },
				{ label: "Cloudflare", href: "/infra/cloudflare?view=workers" },
				{ label: scriptName },
			]}
			time={{ search, startTime, endTime, defaultPreset: "12h", onChange: handleTimeChange }}
			rightPanel={
				<CloudflareWorkerRail
					accountName={accountName}
					row={row}
					deploys={markers.map((m) => ({ commitSha: m.id, firstSeen: m.at }))}
					traced={traced}
				/>
			}
			gap="lg"
		>
			<CloudflareWorkerHeader
				scriptName={scriptName}
				row={row}
				accountName={accountName}
				tracedService={traced?.service ?? null}
				currentVersion={currentVersion}
			/>
			<ResultView
				result={detailResult}
				loading={
					<div className="space-y-6">
						<Skeleton className="h-96 w-full" />
						<Skeleton className="h-32 w-full" />
					</div>
				}
			>
				{(detail, { waiting }) => {
					const untraced = untracedExceptions(
						workerOutcomeTotals(detail.outcomeBuckets).exceptions,
						traced?.errors ?? null,
					)
					return (
						<div className="space-y-6">
							{untraced === null || traced === null ? null : (
								<CloudflareTraceGapCallout
									exceptions={workerOutcomeTotals(detail.outcomeBuckets).exceptions}
									tracedErrors={traced.errors}
									tracedService={traced.service}
								/>
							)}
							<CloudflareWorkerSignals
								detail={detail}
								row={row}
								markers={markers}
								waiting={waiting}
							/>
							<CloudflareWorkerOutcomes detail={detail} />
						</div>
					)
				}}
			</ResultView>
		</DashboardPage>
	)
}
