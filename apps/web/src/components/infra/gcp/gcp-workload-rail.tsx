import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { ServiceDot } from "@maple/ui/components/service-dot"
import type { UtilizationLevel } from "@maple/ui/lib/utilization"

import {
	ChevronRightIcon,
	ExternalLinkIcon,
	FileIcon,
	GoogleCloudMonoIcon,
	NetworkNodesIcon,
	PulseIcon,
	type IconComponent,
} from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import type { GcpConsoleLinks } from "./inventory"
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

/** A share's tone, in the colours the service health uses: green, amber, red. */
const FACT_TONE = {
	ok: "text-severity-info",
	warn: "text-severity-warn",
	crit: "text-severity-error",
} satisfies Record<UtilizationLevel, string>

/** The logs of a workload in Maple: see `gcpWorkloadTelemetry`. */
interface GcpLogsTarget {
	readonly service: string
	readonly attrs: ReadonlyArray<string>
}

/**
 * The workload page's right rail: where it runs, what the inventory knows, its readings, the
 * traced service of its name, and every link out: its logs, traces and service map in Maple, its
 * pages in the Google Cloud console.
 */
export function GcpWorkloadRail({
	service,
	project,
	location,
	resource,
	facts,
	health = [],
	traced,
	logs,
	serviceMap,
	consoleLinks,
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
	/**
	 * For a workload named after its code: the traced service of its name, null when none sent
	 * spans in the window. Undefined for a managed service, which no service is named after.
	 */
	traced?: { readonly name: string; readonly service: string | null }
	logs: GcpLogsTarget
	/** Links to the service map, focused on a service when one calls the workload. */
	serviceMap?: { readonly focusService: string | undefined }
	consoleLinks: GcpConsoleLinks
	timeSearch: TimeRangeSearch
}) {
	const inventory = service === "gke" ? undefined : resource
	const labels =
		inventory === undefined
			? []
			: Object.entries(inventory.labels).map(([key, value]) => `${key}=${value}`)
	const tracedService = traced?.service ?? null
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
				{facts.map((fact, index) => (
					<DetailRail.MetaRow
						// Several read replicas repeat a label.
						key={`${fact.label}:${index}`}
						label={fact.label}
						value={fact.value}
						valueClassName={fact.tone === undefined ? undefined : FACT_TONE[fact.tone]}
					/>
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
						<DetailRail.MetaRow
							key={fact.label}
							label={fact.label}
							value={fact.value}
							valueClassName={fact.tone === undefined ? undefined : FACT_TONE[fact.tone]}
						/>
					))}
				</DetailRail.Group>
			)}
			{traced === undefined ? null : (
				<DetailRail.Group label="Traced as">
					{traced.service === null ? (
						<p className="text-2xs leading-relaxed text-muted-foreground">
							No service named {traced.name} sent spans in this window, so Google Cloud's
							metrics are all there is.
						</p>
					) : (
						<Link
							to="/services/$serviceName"
							params={{ serviceName: traced.service }}
							search={timeSearch}
							className={RAIL_LINK}
						>
							<span className="flex w-3.5 shrink-0 justify-center">
								<ServiceDot serviceName={traced.service} />
							</span>
							<RailLinkLabel>{traced.service}</RailLinkLabel>
							<Chevron />
						</Link>
					)}
				</DetailRail.Group>
			)}
			<DetailRail.Group label="Explore">
				<Link
					to="/logs"
					search={{
						...timeSearch,
						services: [logs.service],
						attrs: logs.attrs.length > 0 ? [...logs.attrs] : undefined,
					}}
					className={RAIL_LINK}
				>
					<RailLinkBody icon={FileIcon}>Logs</RailLinkBody>
				</Link>
				{tracedService === null ? null : (
					<Link
						to="/traces"
						search={{ ...timeSearch, services: [tracedService] }}
						className={RAIL_LINK}
					>
						<RailLinkBody icon={PulseIcon}>Traces</RailLinkBody>
					</Link>
				)}
				{serviceMap === undefined && tracedService === null ? null : (
					<Link
						to="/service-map"
						search={{
							...timeSearch,
							focusService: serviceMap?.focusService ?? tracedService ?? undefined,
						}}
						className={RAIL_LINK}
					>
						<RailLinkBody icon={NetworkNodesIcon}>Service map</RailLinkBody>
					</Link>
				)}
			</DetailRail.Group>
			<DetailRail.Group label="Google Cloud console">
				<ExternalRailLink href={consoleLinks.page.href} icon={GoogleCloudMonoIcon}>
					{consoleLinks.page.label}
				</ExternalRailLink>
				<ExternalRailLink href={consoleLinks.logs} icon={FileIcon}>
					Logs Explorer
				</ExternalRailLink>
			</DetailRail.Group>
		</div>
	)
}

const RAIL_LINK =
	"group -mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-xs text-foreground/85 transition-colors hover:bg-muted/60 hover:text-foreground"

function RailLinkLabel({ children }: { children: ReactNode }) {
	return <span className="min-w-0 flex-1 truncate">{children}</span>
}

function Chevron() {
	return (
		<ChevronRightIcon
			size={12}
			className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground"
		/>
	)
}

/** A rail link's inside: its glyph, its label, and a chevron that wakes on hover. */
function RailLinkBody({ icon: Icon, children }: { icon: IconComponent; children: string }) {
	return (
		<>
			<Icon size={14} className="shrink-0 text-muted-foreground group-hover:text-foreground" />
			<RailLinkLabel>{children}</RailLinkLabel>
			<Chevron />
		</>
	)
}

/** A link out of Maple: opens in a new tab, and says so with its trailing glyph. */
function ExternalRailLink({
	href,
	icon: Icon,
	children,
}: {
	href: string
	icon: IconComponent
	children: string
}) {
	return (
		<a href={href} target="_blank" rel="noreferrer" className={RAIL_LINK}>
			<Icon size={14} className="shrink-0 text-muted-foreground group-hover:text-foreground" />
			<RailLinkLabel>{children}</RailLinkLabel>
			<ExternalLinkIcon
				size={12}
				className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground"
			/>
		</a>
	)
}
