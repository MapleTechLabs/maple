import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { useMemo, useState } from "react"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import type { RailwayServiceRow } from "@/api/warehouse/railway-infra"
import type { PlanetScaleDatabaseStat } from "@/api/warehouse/service-map"
import { HostSummaryBand, type HostScope, hostInScope } from "@/components/infra/host-summary-band"
import { HostTable, type HostRow } from "@/components/infra/host-table"
import {
	FINDINGS_LIST_CLASS,
	FindingRow,
	SectionHeading,
	SourceLink,
	SourceRowBody,
} from "@/components/infra/overview/infra-overview"
import {
	type SourceId,
	type SourceSummary,
	summarizeCloudflare,
	summarizeContainers,
	summarizeHosts,
	summarizePlanetScale,
	summarizePods,
	summarizeRailway,
} from "@/components/infra/overview/summaries"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
import { ListToolbar } from "@/components/infra/primitives/list-toolbar"
import { PageHero } from "@/components/infra/primitives/page-hero"
import {
	RailwayServiceTable,
	RailwaySummaryBand,
	type RailwayScope,
	railwayInScope,
} from "@/components/infra/railway/railway-service-table"

const NOW = Date.now()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const END = ago(0)

const host = (
	hostName: string,
	cpuPct: number,
	memoryPct: number,
	diskPct: number,
	seenMs = 4_000,
): HostRow => ({
	hostName,
	osType: "linux",
	hostArch: hostName.startsWith("db") ? "arm64" : "amd64",
	cloudProvider: "aws",
	lastSeen: ago(seenMs),
	cpuPct,
	memoryPct,
	diskPct,
	load15: cpuPct * 8,
})

const HOSTS: ReadonlyArray<HostRow> = [
	host("worker-eu-07", 0.94, 0.62, 0.41),
	host("api-eu-02", 0.81, 0.74, 0.33),
	host("ingest-eu-01", 0.66, 0.58, 0.29),
	host("db-proxy-eu-01", 0.47, 0.58, 0.19),
	{ ...host("edge-eu-03", 0.22, 0.31, 0.12), cloudProvider: "gcp" },
	{ ...host("win-agent-01", 0.19, 0.28, 0.12), osType: "windows", cloudProvider: "azure" },
	host("scheduler-eu-01", 0.11, 0.24, 0.31),
	{ ...host("build-runner-03", 0.05, 0.12, 0.44, 2 * 60 * 60 * 1000), osType: "darwin", hostArch: "arm64" },
]

const railway = (
	serviceName: string,
	cpuMax: number,
	cpuLimit: number,
	memoryMaxGb: number,
	memoryLimitGb: number,
	replicas: number,
): RailwayServiceRow => ({
	environmentId: "env-prod",
	serviceId: `svc-${serviceName}`,
	serviceName,
	projectName: "storefront",
	environmentName: "production",
	cpuAvg: cpuMax * 0.7,
	cpuMax,
	cpuLimit,
	memoryAvg: memoryMaxGb * 0.8 * 1e9,
	memoryMax: memoryMaxGb * 1e9,
	memoryLimit: memoryLimitGb * 1e9,
	replicas,
	lastSeen: ago(60_000),
})

const RAILWAY: ReadonlyArray<RailwayServiceRow> = [
	railway("api", 1.86, 2, 2.4, 4, 3),
	railway("worker", 1.52, 4, 4.2, 8, 2),
	railway("web", 0.21, 1, 0.33, 1, 4),
	railway("postgres", 0.24, 2, 1.8, 4, 1),
	railway("nightly-export", 0.04, 0, 0.1, 0, 1),
]

const zone = (
	zoneName: string,
	requests: number,
	errorRate: number,
	originP99Ms: number,
): CloudflareZoneRow => ({
	serviceName: `cloudflare/${zoneName}`,
	zoneName,
	requests,
	errors5xx: Math.round(requests * errorRate),
	errorRate,
	cacheHits: requests * 0.91,
	cacheHitRate: 0.91,
	bytes: 0,
	visits: 0,
	ttfbP50Ms: 0,
	ttfbP95Ms: 0,
	ttfbP99Ms: 0,
	originP50Ms: 0,
	originP95Ms: 0,
	originP99Ms,
})

const ZONES: ReadonlyArray<CloudflareZoneRow> = [
	zone("api.acme.dev", 21_400_000, 0.042, 2400),
	zone("acme.dev", 18_900_000, 0.001, 310),
	zone("docs.acme.dev", 7_900_000, 0, 120),
]

const db = (
	database: string,
	replicaLagMaxSeconds: number,
	storageUsedPercent: number,
): PlanetScaleDatabaseStat => ({
	database,
	connectionsAvg: 40,
	connectionsMax: 80,
	cpuMaxPercent: 30,
	memMaxPercent: 40,
	replicaLagMaxSeconds,
	storageUsedPercent,
})

const DATABASES: ReadonlyArray<PlanetScaleDatabaseStat> = [
	db("ledger", 41, 81),
	db("users", 0.2, 34),
	db("events", 0.4, 52),
]

const SUMMARIES: ReadonlyArray<readonly [SourceId, SourceSummary]> = [
	["hosts", summarizeHosts(HOSTS, END)],
	[
		"containers",
		summarizeContainers({
			totalContainers: 41,
			saturatedContainers: 1,
			elevatedContainers: 4,
			staleContainers: 0,
		}),
	],
	[
		"kubernetes",
		summarizePods({ livePods: 562, endedPods: 12, saturatedPods: 9, elevatedPods: 18, unboundedPods: 0 }),
	],
	["cloudflare", summarizeCloudflare(ZONES)],
	["railway", summarizeRailway(RAILWAY)],
	["planetscale", summarizePlanetScale(DATABASES)],
]

const RANK = { crit: 0, warn: 1, stale: 2 } as const

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="space-y-6 border-b pb-16" data-lab-frame={label}>
			<Eyebrow as="div">{label}</Eyebrow>
			{children}
		</section>
	)
}

/** The infra rethink's three surfaces over fixture rows: overview, hosts list, Railway list. */
export function InfraLab() {
	const findings = SUMMARIES.flatMap(([, summary]) => summary.findings).sort(
		(a, b) => RANK[a.tone] - RANK[b.tone],
	)
	const [hostQuery, setHostQuery] = useState("")
	const [hostScope, setHostScope] = useState<HostScope | undefined>()
	const [railwayScope, setRailwayScope] = useState<RailwayScope | undefined>()

	const hosts = useMemo(
		() =>
			HOSTS.filter(
				(h) =>
					(!hostScope || hostInScope(h, hostScope, END)) &&
					h.hostName.toLowerCase().includes(hostQuery.trim().toLowerCase()),
			),
		[hostQuery, hostScope],
	)
	const services = RAILWAY.filter((row) => !railwayScope || railwayInScope(row, railwayScope))

	return (
		<div className="mx-auto max-w-6xl space-y-16 p-8">
			<Frame label="/infra overview">
				<PageHero
					title="Infrastructure"
					description="6 sources reporting. What needs a look comes first."
				/>
				<div className="space-y-3">
					<SectionHeading title="Needs attention" hint="across every source, worst first" />
					<div className={FINDINGS_LIST_CLASS}>
						{findings.map((finding) => (
							<FindingRow key={finding.key} finding={finding} timeSearch={{}} />
						))}
					</div>
				</div>
				<div className="space-y-3">
					<SectionHeading title="Sources" hint="one row per source reporting to this org" />
					<div className="divide-y overflow-hidden rounded-lg border">
						{SUMMARIES.map(([id, summary]) => (
							<SourceLink key={id} id={id} timeSearch={{}}>
								<SourceRowBody id={id} state={{ status: "ready", summary }} />
							</SourceLink>
						))}
					</div>
				</div>
			</Frame>

			<Frame label="/infra/hosts">
				<PageHero
					title="Hosts"
					description="Every machine sending CPU, memory, disk and network metrics, busiest first."
				/>
				<div className="space-y-4">
					<HostSummaryBand
						hosts={HOSTS}
						referenceTime={END}
						activeScope={hostScope}
						onScopeChange={setHostScope}
						className={FLEET_BAND_BOXED}
					/>
					<ListToolbar
						value={hostQuery}
						onChange={setHostQuery}
						placeholder="Search hosts…"
						trailing={`${hosts.length} of ${HOSTS.length} hosts`}
					/>
					<HostTable hosts={hosts} />
				</div>
			</Frame>

			<Frame label="/infra/railway">
				<PageHero
					title="Railway"
					description="CPU, memory, network and disk for every Railway service, polled from Railway's metrics API."
				/>
				<div className="space-y-4">
					<RailwaySummaryBand
						services={RAILWAY}
						activeScope={railwayScope}
						onScopeChange={setRailwayScope}
						className={FLEET_BAND_BOXED}
					/>
					<ListToolbar
						value=""
						onChange={() => undefined}
						placeholder="Search services…"
						trailing={`${services.length} services`}
					/>
					<RailwayServiceTable services={services} />
				</div>
			</Frame>
		</div>
	)
}
