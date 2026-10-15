import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"
import { DetailRail } from "@maple/ui/components/detail-rail"

import { ExternalLinkIcon } from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import type { GcpLogsTarget } from "./gcp-workload-page"
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

/** The workload page's right rail: where it runs, what the inventory knows, its readings, and links out. */
export function GcpWorkloadRail({
	service,
	project,
	location,
	resource,
	facts,
	health = [],
	serviceMap,
	tracedService,
	logs,
	consolePage,
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
	logs: GcpLogsTarget
	consolePage: { readonly label: string; readonly href: string } | undefined
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
			<DetailRail.Group label="Also">
				{serviceMap === undefined ? null : (
					<RailLink>
						<Link
							to="/service-map"
							search={{
								...timeSearch,
								focusService: serviceMap.focusService,
							}}
						>
							Open in Service Map
						</Link>
					</RailLink>
				)}
				{tracedService === null ? null : (
					<RailLink>
						<Link to="/services/$serviceName" params={{ serviceName: tracedService }}>
							Open {tracedService} service
						</Link>
					</RailLink>
				)}
				<RailLink>
					<Link
						to="/logs"
						search={{
							...timeSearch,
							services: [logs.service],
							attrs: logs.attrs.length > 0 ? [...logs.attrs] : undefined,
						}}
					>
						Logs
					</Link>
				</RailLink>
				{consolePage === undefined ? null : (
					<RailLink>
						<a
							href={consolePage.href}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1"
						>
							{consolePage.label} in Google Cloud
							<ExternalLinkIcon size={12} />
						</a>
					</RailLink>
				)}
			</DetailRail.Group>
		</div>
	)
}

function RailLink({ children }: { children: ReactNode }) {
	return (
		<div className="font-mono text-xs text-primary transition-colors hover:text-primary/80">
			{children}
		</div>
	)
}
