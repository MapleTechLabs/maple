import { useMemo, useState } from "react"

import { Result } from "@/lib/effect-atom"
import { cn } from "@maple/ui/lib/utils"

import type { CloudflareBreakdownDimension } from "@/api/warehouse/cloudflare-infra"
import { HeroChip, PageHero } from "@/components/common/page-hero"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { CloudflareBreakdownPanelBody } from "@/components/infra/cloudflare/cloudflare-breakdown-panel"
import type { CloudflareView } from "@/components/infra/cloudflare/list-model"
import {
	CloudflareListPage,
	type CloudflareListState,
} from "@/components/infra/cloudflare/cloudflare-list-page"
import { cloudflareAccounts } from "@/components/infra/cloudflare/accounts"
import { CloudflareZoneRail } from "@/components/infra/cloudflare/cloudflare-zone-rail"
import {
	CloudflareZoneSignals,
	zoneSeverityClass,
} from "@/components/infra/cloudflare/cloudflare-zone-signals"
import { mergeWorkerRows } from "@/components/infra/cloudflare/list-model"
import { zoneSignalTotals } from "@/components/infra/cloudflare/zone-signals"
import {
	CloudflareTraceGapCallout,
	CloudflareWorkerHeader,
	CloudflareWorkerOutcomes,
	CloudflareWorkerRail,
	CloudflareWorkerSignals,
} from "@/components/infra/cloudflare/cloudflare-worker-page"
import { deployMarkers, workerOutcomeTotals } from "@/components/infra/cloudflare/worker-signals"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import {
	MAKI_DURABLE_OBJECTS,
	MAKI_QUEUES,
	MAKI_WORKERS,
	MAKI_ZONE_SPARKS,
	MAKI_ZONES,
	MAPLE_DEV_CACHE,
	MAPLE_DEV_PATHS,
	MAPLE_DEV_ROW,
	MAPLE_DEV_STATUS,
	MAPLE_API_DETAIL,
	MAPLE_API_RELEASES,
	DEMO_ACCOUNT_STATUSES,
	DEMO_DURABLE_OBJECTS,
	DEMO_NOW,
	DEMO_WORKERS,
} from "./cloudflare-fixture"

const PAGES = ["zones", "workers", "queues", "zone", "worker", "accounts"] as const
type LabPage = (typeof PAGES)[number]
const PAGE_LABEL = {
	zones: "List · Zones",
	workers: "List · Workers",
	queues: "List · Queues",
	zone: "Zone · maple.dev",
	worker: "Worker · maple-api",
	accounts: "3 accounts (demo)",
} satisfies Record<LabPage, string>

/** The redesigned Cloudflare pages, whole, over a copy of production data (Maki Account, 2026-10-14). */
export function CloudflareLab() {
	const [page, setPage] = useState<LabPage>("zones")
	const [multiView, setMultiView] = useState<CloudflareView>("zones")
	return (
		<>
			<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-lg">
				<span className="font-mono text-2xs text-muted-foreground">Cloudflare lab</span>
				<SegmentPivot<LabPage>
					ariaLabel="Lab page"
					options={PAGES.map((value) => ({ value, label: PAGE_LABEL[value] }))}
					value={page}
					onChange={setPage}
				/>
			</div>
			{page === "zone" ? (
				<ZonePage />
			) : page === "worker" ? (
				<WorkerPage />
			) : page === "accounts" ? (
				<ListPage view={multiView} multiAccount onViewChange={setMultiView} />
			) : (
				<ListPage view={page} multiAccount={false} onViewChange={(view) => setPage(view)} />
			)}
		</>
	)
}

function ListPage({
	view,
	multiAccount,
	onViewChange,
}: {
	view: CloudflareView
	multiAccount: boolean
	onViewChange: (view: CloudflareView) => void
}) {
	const [state, setState] = useState<CloudflareListState>({})
	const accounts = useMemo(
		() => (multiAccount ? cloudflareAccounts(DEMO_ACCOUNT_STATUSES, DEMO_NOW) : []),
		[multiAccount],
	)
	const workerRows = useMemo(
		() =>
			multiAccount
				? mergeWorkerRows(DEMO_WORKERS, DEMO_DURABLE_OBJECTS)
				: mergeWorkerRows(MAKI_WORKERS, MAKI_DURABLE_OBJECTS),
		[multiAccount],
	)
	const queues = multiAccount ? MAKI_QUEUES.map((q) => ({ ...q, accountId: "acct-maple" })) : MAKI_QUEUES
	return (
		<DashboardPage breadcrumbs={[{ label: "Infrastructure" }, { label: "Cloudflare" }]} gap="lg">
			<CloudflareListPage
				accounts={accounts}
				singleAccountName="Maki Account"
				zones={MAKI_ZONES}
				sparks={MAKI_ZONE_SPARKS}
				workerRows={workerRows}
				queues={queues}
				state={{ ...state, view }}
				onStateChange={(patch) => {
					if (patch.view !== undefined) onViewChange(patch.view)
					setState((prev) => ({ ...prev, ...patch }))
				}}
			/>
		</DashboardPage>
	)
}

function ZonePage() {
	const [dimension, setDimension] = useState<CloudflareBreakdownDimension>("path")
	const severity = zoneSeverityClass(zoneSignalTotals(MAPLE_DEV_STATUS, MAPLE_DEV_CACHE))
	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure" }, { label: "Cloudflare" }, { label: "maple.dev" }]}
			rightPanel={
				<CloudflareZoneRail
					serviceName={MAPLE_DEV_ROW.serviceName}
					accountName="Maki Account"
					zoneRow={MAPLE_DEV_ROW}
					dns={{ queries: 4_400_000, alwaysNxdomain: 4 }}
					firewallEvents={0}
					onOpenTab={() => undefined}
				/>
			}
			gap="lg"
		>
			<PageHero
				title={
					<span className="flex items-center gap-3">
						<span aria-hidden className={cn("size-2 shrink-0 rounded-full", severity)} />
						maple.dev
					</span>
				}
				actions={
					<SegmentPivot
						ariaLabel="Zone view"
						options={[
							{ value: "traffic", label: "Traffic" },
							{ value: "dns", label: "DNS" },
						]}
						value="traffic"
						onChange={() => undefined}
					/>
				}
				meta={
					<>
						<HeroChip>zone</HeroChip>
						<HeroChip>account Maki Account</HeroChip>
					</>
				}
			/>
			<div className="space-y-6">
				<CloudflareZoneSignals
					statusBuckets={MAPLE_DEV_STATUS}
					cacheBuckets={MAPLE_DEV_CACHE}
					latencyBuckets={[]}
					zoneRow={MAPLE_DEV_ROW}
				/>
				<CloudflareBreakdownPanelBody
					zoneName="maple.dev"
					startTime="2026-10-14 00:00:00"
					endTime="2026-10-14 12:00:00"
					filters={{}}
					onToggleFilter={() => undefined}
					dimensionId={dimension}
					onDimensionChange={setDimension}
					storedResult={Result.success(MAPLE_DEV_PATHS)}
				/>
			</div>
		</DashboardPage>
	)
}

function WorkerPage() {
	const row = useMemo(
		() =>
			mergeWorkerRows(MAKI_WORKERS, MAKI_DURABLE_OBJECTS).find((w) => w.scriptName === "maple-api") ??
			null,
		[],
	)
	const markers = deployMarkers(MAPLE_API_RELEASES, "2026-10-14T00:00:00.000Z", 1800)
	const tracedErrors = MAPLE_API_RELEASES.reduce((acc, r) => acc + r.errorCount, 0)
	const exceptions = workerOutcomeTotals(MAPLE_API_DETAIL.outcomeBuckets).exceptions
	return (
		<DashboardPage
			breadcrumbs={[{ label: "Infrastructure" }, { label: "Cloudflare" }, { label: "maple-api" }]}
			rightPanel={
				<CloudflareWorkerRail
					accountName="Maki Account"
					row={row}
					deploys={markers.map((m) => ({ commitSha: m.id, firstSeen: m.at }))}
					traced={{
						service: "maple-api",
						spans: MAPLE_API_RELEASES.reduce((acc, r) => acc + r.spanCount, 0),
						errors: tracedErrors,
					}}
				/>
			}
			gap="lg"
		>
			<CloudflareWorkerHeader
				scriptName="maple-api"
				row={row}
				accountName="Maki Account"
				tracedService="maple-api"
				currentVersion="701d72fccc06ba1603e4fac244ac1379f2da0896"
			/>
			<div className="space-y-6">
				<CloudflareTraceGapCallout
					exceptions={exceptions}
					tracedErrors={tracedErrors}
					tracedService="maple-api"
				/>
				<CloudflareWorkerSignals detail={MAPLE_API_DETAIL} row={row} markers={markers} />
				<CloudflareWorkerOutcomes detail={MAPLE_API_DETAIL} />
			</div>
		</DashboardPage>
	)
}
