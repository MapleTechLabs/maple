import { Link } from "@tanstack/react-router"

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"
import { DetailRail } from "@maple/ui/components/detail-rail"

import { ChevronRightIcon, NetworkNodesIcon, PulseIcon, type IconComponent } from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import { gcpStateLabel } from "./tabs"
import type { GcpRailFact } from "./workload-signals"

const RAIL_TITLE = {
	cloudRun: "Cloud Run service",
	cloudFunctions: "Cloud Function",
	gke: "GKE container",
	computeEngine: "VM instance",
	cloudSql: "Cloud SQL instance",
	pubsub: "Pub/Sub subscription",
	loadBalancing: "Load balancer",
} satisfies Record<GcpInfraServiceId, string>

/** The workload page's right rail: where it runs, what the inventory knows, its readings, and related pages. Logs and the console page are the hero's buttons. */
export function GcpWorkloadRail({
	service,
	project,
	location,
	resource,
	facts,
	health = [],
	serviceMap,
	tracedService,
	timeSearch,
}: {
	service: GcpInfraServiceId
	project: string | undefined
	location: string | undefined
	/** The workload's inventory resource; a container's is its cluster, whose state is not the container's. */
	resource: GcpResource | undefined
	facts: ReadonlyArray<GcpRailFact>
	/** How the workload is doing underneath: a Cloud SQL instance's deadlocks, cache hits. */
	health?: ReadonlyArray<GcpRailFact>
	/** Links to the service map, focused on a service when one calls the workload. */
	serviceMap?: { readonly focusService: string | undefined }
	tracedService: string | null
	timeSearch: TimeRangeSearch
}) {
	const inventory = service === "gke" ? undefined : resource
	const labels =
		inventory === undefined
			? []
			: Object.entries(inventory.labels).map(([key, value]) => `${key}=${value}`)
	return (
		<div className="flex flex-col">
			<DetailRail.Group label={RAIL_TITLE[service]}>
				<DetailRail.MetaRow label="location" value={location} />
				<DetailRail.MetaRow label="project" value={project} />
				<DetailRail.MetaRow
					label="state"
					value={
						inventory === undefined || inventory.state === null
							? null
							: gcpStateLabel(inventory.state)
					}
				/>
				{facts.map((fact) => (
					<DetailRail.MetaRow key={fact.label} label={fact.label} value={fact.value} />
				))}
				{labels.length === 0 ? null : (
					<DetailRail.Field label="labels">
						<div className="flex flex-wrap gap-1">
							{labels.map((label) => (
								<span
									key={label}
									title={label}
									className="max-w-full truncate rounded-sm bg-muted px-1.5 font-mono text-2xs/[18px]"
								>
									{label}
								</span>
							))}
						</div>
					</DetailRail.Field>
				)}
			</DetailRail.Group>
			{health.length === 0 ? null : (
				<DetailRail.Group label="Health">
					{health.map((fact) => (
						<DetailRail.MetaRow key={fact.label} label={fact.label} value={fact.value} />
					))}
				</DetailRail.Group>
			)}
			{serviceMap === undefined && tracedService === null ? null : (
				<DetailRail.Group label="Related">
					{serviceMap === undefined ? null : (
						<Link
							to="/service-map"
							search={{ ...timeSearch, focusService: serviceMap.focusService }}
							className={RAIL_LINK}
						>
							<RailLinkBody icon={NetworkNodesIcon}>Service map</RailLinkBody>
						</Link>
					)}
					{tracedService === null ? null : (
						<Link
							to="/services/$serviceName"
							params={{ serviceName: tracedService }}
							className={RAIL_LINK}
						>
							<RailLinkBody icon={PulseIcon}>{tracedService}</RailLinkBody>
						</Link>
					)}
				</DetailRail.Group>
			)}
		</div>
	)
}

const RAIL_LINK =
	"group -mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-xs text-foreground/85 transition-colors hover:bg-muted/60 hover:text-foreground"

/** A rail link's inside: its glyph, its label, and a chevron that wakes on hover. */
function RailLinkBody({ icon: Icon, children }: { icon: IconComponent; children: string }) {
	return (
		<>
			<Icon size={14} className="shrink-0 text-muted-foreground group-hover:text-foreground" />
			<span className="min-w-0 flex-1 truncate">{children}</span>
			<ChevronRightIcon
				size={12}
				className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground"
			/>
		</>
	)
}
