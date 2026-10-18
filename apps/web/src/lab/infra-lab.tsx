import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { useMemo, useState } from "react"

import { HostSummaryBand, type HostScope, hostInScope } from "@/components/infra/host-summary-band"
import { HostTable } from "@/components/infra/host-table"
import {
	FINDINGS_LIST_CLASS,
	FindingRow,
	SourceLink,
	SourceRowBody,
} from "@/components/infra/overview/infra-overview"
import { SectionHeading } from "@/components/common/section-heading"
import { buildInfraLabFixture } from "@/lab/infra-fixture"
import { FLEET_BAND_BOXED } from "@/components/infra/primitives/fleet-band"
import { SearchToolbar } from "@/components/common/search-toolbar"
import { PageHero } from "@/components/common/page-hero"
import { RailwayFleetBand, RailwayServiceTable } from "@/components/infra/railway/railway-service-table"
import { hasConfiguredLimits } from "@/components/infra/railway/list-model"

const {
	end: END,
	hosts: HOSTS,
	railway: RAILWAY,
	railwayEnvironments: RAILWAY_ENVIRONMENTS,
	summaries: SUMMARIES,
} = buildInfraLabFixture(Date.now())

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

	const hosts = useMemo(
		() =>
			HOSTS.filter(
				(h) =>
					(!hostScope || hostInScope(h, hostScope, END)) &&
					h.hostName.toLowerCase().includes(hostQuery.trim().toLowerCase()),
			),
		[hostQuery, hostScope],
	)

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
					<SearchToolbar
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
					<RailwayFleetBand
						services={RAILWAY}
						environments={RAILWAY_ENVIRONMENTS}
						authFailed={false}
						className={FLEET_BAND_BOXED}
					/>
					<SearchToolbar
						value=""
						onChange={() => undefined}
						placeholder="Search services…"
						trailing={`${RAILWAY.length} services`}
					/>
					<RailwayServiceTable
						services={RAILWAY}
						environments={RAILWAY_ENVIRONMENTS}
						authFailed={false}
						showLimits={hasConfiguredLimits(RAILWAY)}
					/>
				</div>
			</Frame>
		</div>
	)
}
