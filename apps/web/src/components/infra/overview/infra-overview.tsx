import { StatusDot } from "@maple/ui/components/ui/status-dot"
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import {
	ChevronRightIcon,
	CloudflareIcon,
	DockerIcon,
	KubernetesIcon,
	PlanetScaleIcon,
	RailwayIcon,
	ServerIcon,
	type IconComponent,
} from "@/components/icons"
import type { NavSurface } from "@/components/dashboard/nav-items"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	cloudflareZonesResultAtom,
	containersSummaryResultAtom,
	getServiceMapPlanetScaleResultAtom,
	listHostsResultAtom,
	podsSummaryResultAtom,
	railwayServicesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"

import { HOST_LIST_LIMIT } from "../host-summary-band"
import {
	type Finding,
	type FindingTarget,
	type HealthSegment,
	type SourceId,
	type SourceSummary,
	summarizeCloudflare,
	summarizeContainers,
	summarizeHosts,
	summarizePlanetScale,
	summarizePods,
	summarizeRailway,
} from "./summaries"

export interface OverviewWindow {
	readonly startTime: string
	readonly endTime: string
}

export const SOURCE_ORDER: ReadonlyArray<SourceId> = [
	"hosts",
	"containers",
	"kubernetes",
	"cloudflare",
	"railway",
	"planetscale",
]

export const SOURCE_TITLE: Record<SourceId, string> = {
	hosts: "Hosts",
	containers: "Containers",
	kubernetes: "Kubernetes",
	cloudflare: "Cloudflare",
	railway: "Railway",
	planetscale: "PlanetScale",
} satisfies Record<SourceId, string>

/**
 * The sidebar's marks, so a source reads the same here as in the nav. Railway,
 * PlanetScale and the server glyph are monochrome and draw in full text ink;
 * the sidebar's grey PlanetScale tint read as disabled beside the coloured ones.
 */
const SOURCE_ICON: Record<SourceId, IconComponent> = {
	hosts: ServerIcon,
	containers: DockerIcon,
	kubernetes: KubernetesIcon,
	cloudflare: CloudflareIcon,
	railway: RailwayIcon,
	planetscale: PlanetScaleIcon,
} satisfies Record<SourceId, IconComponent>

function SourceMark({ id, size }: { id: SourceId; size: number }) {
	const Icon = SOURCE_ICON[id]
	return <Icon size={size} className="shrink-0 text-foreground" />
}

const SOURCE_SURFACES: Record<SourceId, ReadonlyArray<NavSurface>> = {
	hosts: ["hosts"],
	containers: ["containers"],
	kubernetes: ["k8sPods", "k8sNodes", "k8sWorkloads"],
	cloudflare: ["cloudflare"],
	railway: ["railway"],
	planetscale: ["planetscale"],
} satisfies Record<SourceId, ReadonlyArray<NavSurface>>

/** The sources an org has. Unknown presence (`null`) shows every source rather than hiding one. */
export function presentSources(surfaces: ReadonlySet<NavSurface> | null): ReadonlyArray<SourceId> {
	if (surfaces === null) return SOURCE_ORDER
	return SOURCE_ORDER.filter((id) => SOURCE_SURFACES[id].some((surface) => surfaces.has(surface)))
}

export type SourceState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly summary: SourceSummary }

type RenderState = (state: SourceState) => ReactNode

function toState<A>(result: Result.Result<A, unknown>, summarize: (value: A) => SourceSummary): SourceState {
	return Result.builder(result)
		.onSuccess((value): SourceState => ({ status: "ready", summary: summarize(value) }))
		.onInitial((): SourceState => ({ status: "loading" }))
		.orElse((): SourceState => ({ status: "error" }))
}

function HostsData({ window, render }: { window: OverviewWindow; render: RenderState }) {
	const result = useAtomValue(listHostsResultAtom({ data: { ...window, limit: HOST_LIST_LIMIT } }))
	return render(toState(result, (response) => summarizeHosts(response.data, window.endTime)))
}

function ContainersData({ window, render }: { window: OverviewWindow; render: RenderState }) {
	const result = useAtomValue(containersSummaryResultAtom({ data: window }))
	return render(toState(result, summarizeContainers))
}

function KubernetesData({ window, render }: { window: OverviewWindow; render: RenderState }) {
	const result = useAtomValue(podsSummaryResultAtom({ data: window }))
	return render(toState(result, summarizePods))
}

function CloudflareData({ window, render }: { window: OverviewWindow; render: RenderState }) {
	const result = useAtomValue(cloudflareZonesResultAtom({ data: window }))
	return render(toState(result, (response) => summarizeCloudflare(response.zones)))
}

function RailwayData({ window, render }: { window: OverviewWindow; render: RenderState }) {
	const result = useAtomValue(railwayServicesResultAtom({ data: window }))
	return render(toState(result, (response) => summarizeRailway(response.services)))
}

function PlanetScaleData({ window, render }: { window: OverviewWindow; render: RenderState }) {
	const result = useAtomValue(getServiceMapPlanetScaleResultAtom({ data: window }))
	return render(toState(result, (response) => summarizePlanetScale(response.databases)))
}

/**
 * One source's summary, handed to `render`. The findings list and the sources
 * table each mount this for the same source; both read one cached atom.
 */
function SourceData({ id, window, render }: { id: SourceId; window: OverviewWindow; render: RenderState }) {
	switch (id) {
		case "hosts":
			return <HostsData window={window} render={render} />
		case "containers":
			return <ContainersData window={window} render={render} />
		case "kubernetes":
			return <KubernetesData window={window} render={render} />
		case "cloudflare":
			return <CloudflareData window={window} render={render} />
		case "railway":
			return <RailwayData window={window} render={render} />
		case "planetscale":
			return <PlanetScaleData window={window} render={render} />
	}
}

/* ------------------------------------------------------------------------------------------------
 * Needs attention
 * ----------------------------------------------------------------------------------------------*/

const FINDING_DOT: Record<Finding["tone"], string> = {
	crit: "bg-[var(--severity-error)]",
	warn: "bg-[var(--severity-warn)]",
	stale: "border-[1.5px] border-muted-foreground bg-transparent",
} satisfies Record<Finding["tone"], string>

const ROW_CLASS =
	"group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"

/**
 * The findings list. Each source renders its own rows, so no parent can sort
 * them; flex `order` does it instead, worst first across every source. Rows
 * carry a top border pulled up a pixel, which `overflow-hidden` clips on
 * whichever row lands first.
 */
export const FINDINGS_LIST_CLASS = "flex flex-col overflow-hidden rounded-lg border"
const FINDINGS_ROW_CLASS = "-mt-px border-t"

/** Errors sit after warnings: a source we couldn't check outranks one that went quiet. */
const FINDING_ORDER = {
	crit: "order-1",
	warn: "order-2",
	error: "order-3",
	stale: "order-4",
	loading: "order-5",
} as const

function FindingLink({
	target,
	timeSearch,
	className,
	children,
}: {
	target: FindingTarget
	timeSearch: TimeRangeSearch
	className: string
	children: ReactNode
}) {
	switch (target.kind) {
		case "hosts":
			return (
				<Link to="/infra/hosts" search={{ ...timeSearch, scope: target.scope }} className={className}>
					{children}
				</Link>
			)
		case "host":
			return (
				<Link
					to="/infra/hosts/$hostName"
					params={{ hostName: target.hostName }}
					search={timeSearch}
					className={className}
				>
					{children}
				</Link>
			)
		case "containers":
			return (
				<Link
					to="/infra/containers"
					search={{ ...timeSearch, scope: target.scope }}
					className={className}
				>
					{children}
				</Link>
			)
		case "pods":
			return (
				<Link
					to="/infra/kubernetes/pods"
					search={{ ...timeSearch, scope: target.scope }}
					className={className}
				>
					{children}
				</Link>
			)
		case "zone":
			return (
				<Link
					to="/infra/cloudflare/$zoneName"
					params={{ zoneName: target.zoneName }}
					search={timeSearch}
					className={className}
				>
					{children}
				</Link>
			)
		case "railway":
			return (
				<Link
					to="/infra/railway/$serviceId"
					params={{ serviceId: target.serviceId }}
					search={{ ...timeSearch, environmentId: target.environmentId }}
					className={className}
				>
					{children}
				</Link>
			)
		case "planetscale":
			return (
				<Link
					to="/infra/planetscale/$dbName"
					params={{ dbName: target.database }}
					search={timeSearch}
					className={className}
				>
					{children}
				</Link>
			)
	}
}

export function FindingRow({ finding, timeSearch }: { finding: Finding; timeSearch: TimeRangeSearch }) {
	return (
		<FindingLink
			target={finding.target}
			timeSearch={timeSearch}
			className={cn(ROW_CLASS, FINDINGS_ROW_CLASS, FINDING_ORDER[finding.tone])}
		>
			<StatusDot tone="custom" size="lg" className={FINDING_DOT[finding.tone]} />
			<span className="flex w-32 shrink-0 items-center gap-2 text-xs text-muted-foreground">
				<SourceMark id={finding.source} size={14} />
				{SOURCE_TITLE[finding.source]}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm text-foreground group-hover:text-primary">
					{finding.title}
				</span>
				<span className="truncate text-xs text-muted-foreground">{finding.detail}</span>
			</span>
			<ChevronRightIcon size={14} className="shrink-0 text-muted-foreground" />
		</FindingLink>
	)
}

function FindingRowLoading() {
	return (
		<div className={cn("flex items-center gap-4 px-4 py-3", FINDINGS_ROW_CLASS, FINDING_ORDER.loading)}>
			<Skeleton className="size-2 rounded-full" />
			<Skeleton className="h-3 w-28" />
			<Skeleton className="h-4 w-64" />
		</div>
	)
}

/** A source we couldn't read is not an all-clear, so it gets a row of its own. */
function FindingRowError({ id }: { id: SourceId }) {
	return (
		<div className={cn("flex items-center gap-4 px-4 py-3", FINDINGS_ROW_CLASS, FINDING_ORDER.error)}>
			<StatusDot tone="custom" size="lg" className="bg-muted-foreground/60" />
			<span className="flex w-32 shrink-0 items-center gap-2 text-xs text-muted-foreground">
				<SourceMark id={id} size={14} />
				{SOURCE_TITLE[id]}
			</span>
			<span className="text-sm text-muted-foreground">
				Couldn't check this source. Its page shows the error.
			</span>
		</div>
	)
}

/**
 * Every present source's findings in one list. The list empties to an all-clear
 * line through CSS (`peer-empty`), because each source renders its own rows and
 * no parent ever holds them all.
 */
export function NeedsAttention({
	sources,
	window,
	timeSearch,
}: {
	sources: ReadonlyArray<SourceId>
	window: OverviewWindow
	timeSearch: TimeRangeSearch
}) {
	return (
		<section className="space-y-3">
			<SectionHeading title="Needs attention" hint="across every source, worst first" />
			<div className={cn("peer empty:hidden", FINDINGS_LIST_CLASS)}>
				{sources.map((id) => (
					<SourceData
						key={id}
						id={id}
						window={window}
						render={(state) =>
							state.status === "ready" ? (
								state.summary.findings.map((finding) => (
									<FindingRow key={finding.key} finding={finding} timeSearch={timeSearch} />
								))
							) : state.status === "loading" ? (
								// Holds the list open so the all-clear line can't show before the data does.
								<FindingRowLoading />
							) : (
								<FindingRowError id={id} />
							)
						}
					/>
				))}
			</div>
			<p className="hidden rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground peer-empty:block">
				Nothing is over its thresholds in this window.
			</p>
		</section>
	)
}

/* ------------------------------------------------------------------------------------------------
 * Sources
 * ----------------------------------------------------------------------------------------------*/

const SEGMENT_CLASS: Record<HealthSegment["key"], string> = {
	ok: "bg-muted-foreground/35",
	elevated: "bg-[var(--severity-warn)]",
	saturated: "bg-[var(--severity-error)]",
	// Hatched, not a fill: there is no limit to measure against, and a plain
	// `bg-muted` vanished into the track.
	unbounded:
		"bg-[repeating-linear-gradient(135deg,var(--muted-foreground)_0_1.5px,transparent_1.5px_4px)] opacity-60",
} satisfies Record<HealthSegment["key"], string>

const SEGMENT_LABEL: Record<HealthSegment["key"], string> = {
	ok: "ok",
	elevated: "elevated",
	saturated: "saturated",
	unbounded: "no limit",
} satisfies Record<HealthSegment["key"], string>

const HEADLINE_TONE: Record<SourceSummary["headlineTone"], string> = {
	neutral: "text-foreground",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
} satisfies Record<SourceSummary["headlineTone"], string>

function HealthBar({ segments }: { segments: ReadonlyArray<HealthSegment> }) {
	const total = segments.reduce((sum, segment) => sum + segment.count, 0)
	const drawn = segments.filter((segment) => segment.count > 0)
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted">
				{drawn.map((segment) => (
					<div
						key={segment.key}
						className={SEGMENT_CLASS[segment.key]}
						style={{ width: `${Math.max((segment.count / total) * 100, 2)}%` }}
					/>
				))}
			</div>
			<span className="flex gap-3 text-[11px] text-muted-foreground tabular-nums">
				{drawn.map((segment) => (
					<span key={segment.key}>
						{segment.count.toLocaleString()} {SEGMENT_LABEL[segment.key]}
					</span>
				))}
			</span>
		</div>
	)
}

export function SourceLink({
	id,
	timeSearch,
	children,
}: {
	id: SourceId
	timeSearch: TimeRangeSearch
	children: ReactNode
}) {
	const className = cn(ROW_CLASS, "py-3.5")
	switch (id) {
		case "hosts":
			return (
				<Link to="/infra/hosts" search={timeSearch} className={className}>
					{children}
				</Link>
			)
		case "containers":
			return (
				<Link to="/infra/containers" search={timeSearch} className={className}>
					{children}
				</Link>
			)
		case "kubernetes":
			return (
				<Link to="/infra/kubernetes/pods" search={timeSearch} className={className}>
					{children}
				</Link>
			)
		case "cloudflare":
			return (
				<Link to="/infra/cloudflare" search={timeSearch} className={className}>
					{children}
				</Link>
			)
		case "railway":
			return (
				<Link to="/infra/railway" search={timeSearch} className={className}>
					{children}
				</Link>
			)
		case "planetscale":
			return (
				<Link to="/infra/planetscale" search={timeSearch} className={className}>
					{children}
				</Link>
			)
	}
}

export function SourceRowBody({ id, state }: { id: SourceId; state: SourceState }) {
	return (
		<>
			<span className="flex w-52 shrink-0 items-center gap-3">
				<SourceMark id={id} size={18} />
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="text-sm text-foreground group-hover:text-primary">
						{SOURCE_TITLE[id]}
					</span>
					<span className="text-xs text-muted-foreground">
						{state.status === "ready"
							? state.summary.resources
							: state.status === "error"
								? "Couldn't load"
								: " "}
					</span>
				</span>
			</span>
			<span className="hidden min-w-0 flex-1 pr-6 md:block">
				{state.status === "ready" ? (
					<HealthBar segments={state.summary.segments} />
				) : state.status === "loading" ? (
					<Skeleton className="h-1.5 w-full rounded-full" />
				) : null}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-xs md:w-64 md:flex-none",
					state.status === "ready"
						? HEADLINE_TONE[state.summary.headlineTone]
						: "text-muted-foreground",
				)}
			>
				{state.status === "ready" ? (
					state.summary.headline
				) : state.status === "loading" ? (
					<Skeleton className="h-3 w-40" />
				) : (
					"Open the page for details"
				)}
			</span>
			<ChevronRightIcon size={14} className="shrink-0 text-muted-foreground" />
		</>
	)
}

export function SourcesTable({
	sources,
	window,
	timeSearch,
}: {
	sources: ReadonlyArray<SourceId>
	window: OverviewWindow
	timeSearch: TimeRangeSearch
}) {
	return (
		<section className="space-y-3">
			<SectionHeading title="Sources" hint="one row per source reporting to this org" />
			<div className="divide-y overflow-hidden rounded-lg border">
				{sources.map((id) => (
					<SourceLink key={id} id={id} timeSearch={timeSearch}>
						<SourceData
							id={id}
							window={window}
							render={(state) => <SourceRowBody id={id} state={state} />}
						/>
					</SourceLink>
				))}
			</div>
		</section>
	)
}

export function SectionHeading({ title, hint }: { title: string; hint?: string }) {
	return (
		<div className="flex items-baseline gap-2.5">
			<h2 className="text-sm font-medium text-foreground">{title}</h2>
			{hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
		</div>
	)
}
