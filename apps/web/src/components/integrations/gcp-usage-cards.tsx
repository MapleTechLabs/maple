import { useState } from "react"
import type React from "react"
import { Link } from "@tanstack/react-router"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { ToggleGroup } from "@maple/ui/components/ui/toggle-group"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { StatRail, StatRailItem, StatRailItemSkeleton } from "@/components/common/stat-rail"
import { ArrowRightIcon } from "@/components/icons"
import { gcpValueClass } from "@/components/infra/gcp/gcp-service-table"
import {
	GCP_INFRA_COLUMNS,
	GCP_RESOURCES_TAB,
	formatGcpValue,
	gcpAssetTypeLabel,
	gcpFleet,
	gcpWorkloadLocation,
	gcpWorkloadName,
	gcpWorkloadProject,
	gcpWorkloadSearch,
	gcpWorkloadTone,
} from "@/components/infra/gcp/tabs"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	gcpInfraFleetResultAtom,
	getCustomChartTimeSeriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

import { CountChip } from "./count-chip"
import { GCP_LOG_SOURCE, gcpLogVolume, gcpWorkloadCounts } from "./gcp-usage"
import { GCP_ACCENT } from "./integration-catalog"

/** Every number on the page looks back this far. */
const WINDOW = "24h"

/** A tile's number: null while it loads, "failed" when its read failed. */
type Loaded<A> = A | null | "failed"

const loaded = <A, B>(result: Result.Result<A, unknown>, read: (value: A) => B): Loaded<B> =>
	Result.isSuccess(result) ? read(result.value) : Result.isFailure(result) ? "failed" : null

/**
 * Forwarded entries per hour and severity: the Logs page's volume query, narrowed to the entries
 * ingest stamped as this integration's. It reads the raw `logs` table for the window.
 */
function useGcpLogVolume() {
	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, WINDOW)
	return loaded(
		useAtomValue(
			getCustomChartTimeSeriesResultAtom({
				data: {
					source: "logs",
					metric: "count",
					groupBy: "severity",
					startTime,
					endTime,
					bucketSeconds: 3600,
					filters: { resourceAttributeFilters: [{ ...GCP_LOG_SOURCE, mode: "equals" }] },
				},
			}),
		),
		(response) =>
			gcpLogVolume(response.data, parseWarehouseDateTime(startTime), parseWarehouseDateTime(endTime)),
	)
}

/** The reporting workloads: what the Infrastructure page's band reads, over the page's window. */
function useGcpFleet() {
	const data = useEffectiveTimeRange(undefined, undefined, WINDOW)
	return loaded(useAtomValue(gcpInfraFleetResultAtom({ data })), (fleet) => gcpFleet(fleet.services))
}

/** The inventory by type: the read behind the Infrastructure page's Resources tab. */
function useGcpInventory() {
	return loaded(
		useAtomValue(
			retainedInternalQuery("integrations", "gcpResources", {
				query: {},
				reactivityKeys: ["gcpIntegration"],
			}),
		),
		(response) => ({
			total: response.types.reduce((sum, { count }) => sum + count, 0),
			types: response.types,
			projects: response.projects.length,
		}),
	)
}

/** A tile that is a number and a line under it, or what stands in while its read is out or failed. */
function Tile<A>({
	eyebrow,
	read,
	value,
	caption,
	spark,
	className,
}: {
	eyebrow: string
	read: Loaded<A>
	/** Null for a number that is not there yet: a dash, not a zero that reads as counted. */
	value: (read: A) => number | null
	caption: (read: A) => React.ReactNode
	spark?: (read: A) => ReadonlyArray<number>
	className?: string
}) {
	if (read === null) return <StatRailItemSkeleton className={className} />
	const failed = read === "failed"
	const count = failed ? null : value(read)
	return (
		<StatRailItem
			compact={spark === undefined}
			className={className}
			eyebrow={eyebrow}
			value={count === null ? "–" : formatNumber(count)}
			spark={failed ? undefined : spark?.(read)}
			sparkColor={GCP_ACCENT}
			// It wraps where the tile is narrow: a cut-off caption says nothing.
			subline={
				<span className="block whitespace-normal">
					{failed ? "Not available right now" : caption(read)}
				</span>
			}
		/>
	)
}

/**
 * The connected state's readout, like the Cloudflare page's, over every connection: the numbers at
 * a glance (forwarded log entries and how many of them are errors, workloads reporting metrics, the
 * resource inventory), then the workloads themselves beside the inventory by type. Each comes from
 * a read another page already makes. A capability shows its tiles once it has delivered, so the row
 * is always full: the one that delivers alone gets a third tile of its own. A tile whose read fails
 * says so and the others stay.
 */
export function GcpUsageBand({ connectors }: { connectors: ReadonlyArray<V2GcpConnector> }) {
	const logs = connectors.some((connector) => connector.last_log_received_at !== null)
	const metrics = connectors.some((connector) => connector.last_metrics_received_at !== null)
	if (!logs && !metrics) return null
	return (
		<div className="flex flex-col gap-4">
			{logs && metrics ? (
				// Four across from a page, not a viewport, that is wide enough; two rows of two below that.
				<StatRail className="md:grid-cols-2 md:divide-y @2xl/page:grid-cols-4 @2xl/page:divide-y-0">
					<LogTiles />
					<MetricsTiles />
				</StatRail>
			) : (
				// Three across; on a phone the first takes a row and the other two share the next.
				<StatRail className="md:grid-cols-2 md:divide-y @md/page:grid-cols-3 @md/page:divide-y-0">
					{logs ? <LogTiles alone /> : <MetricsTiles alone />}
				</StatRail>
			)}
			{metrics ? (
				<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
					<Workloads className="min-w-0 flex-1" />
					<Resources className="lg:w-72 lg:shrink-0 xl:w-80" />
				</div>
			) : null}
		</div>
	)
}

/** In two rows of two, no divider against the rail's own right and bottom edge. */
const ROW_END = "border-r-0 @2xl/page:border-r"
const LAST_ROW = "border-b-0"
/** Alone, the first of three tiles takes the phone's first row. */
const FIRST_OF_THREE = "col-span-2 border-r-0 @md/page:col-span-1 @md/page:border-r"

function LogTiles({ alone = false }: { alone?: boolean }) {
	const volume = useGcpLogVolume()
	return (
		<>
			<Tile
				eyebrow="Log entries · 24h"
				read={volume}
				className={alone ? FIRST_OF_THREE : undefined}
				value={({ total }) => total}
				spark={({ hourly }) => hourly}
				caption={({ total, hourly }) =>
					`About ${formatNumber(Math.round(total / hourly.length))} an hour`
				}
			/>
			<Tile
				eyebrow="Errors · 24h"
				read={volume}
				className={alone ? LAST_ROW : ROW_END}
				value={({ errors }) => errors}
				caption={() => "Severity error and above"}
			/>
			{alone ? (
				<Tile
					eyebrow="Warnings · 24h"
					read={volume}
					value={({ warnings }) => warnings}
					caption={() => "Severity warning"}
				/>
			) : null}
		</>
	)
}

function MetricsTiles({ alone = false }: { alone?: boolean }) {
	const fleet = useGcpFleet()
	const inventory = useGcpInventory()
	return (
		<>
			<Tile
				eyebrow="Workloads · 24h"
				read={fleet}
				className={alone ? FIRST_OF_THREE : LAST_ROW}
				value={(services) => services.reduce((sum, { workloads }) => sum + workloads.length, 0)}
				caption={(services) => {
					const reporting = gcpWorkloadCounts(services).length
					return reporting === 0
						? "No metrics in 24 hours"
						: `In ${countLabel(reporting, "Google Cloud service")}`
				}}
			/>
			<Tile
				eyebrow="Resources"
				read={inventory}
				className={alone ? LAST_ROW : undefined}
				value={({ total }) => (total === 0 ? null : total)}
				caption={({ total, projects, types }) =>
					total === 0
						? "Listed within an hour of setup"
						: alone
							? `Of ${countLabel(types.length, "type")}`
							: `In ${countLabel(projects, "project")}`
				}
			/>
			{alone ? (
				<Tile
					eyebrow="Projects"
					read={inventory}
					value={({ total, projects }) => (total === 0 ? null : projects)}
					caption={({ total }) =>
						total === 0 ? "Listed within an hour of setup" : "With a listed resource"
					}
				/>
			) : null}
		</>
	)
}

/** Worst first: what needs a look is at the top of the board. */
const TONE_ORDER = ["crit", "warn", "neutral"] as const
/** How many of a service's columns a row shows. */
const VALUES_SHOWN = 3
/** The second and third value give way where the board is narrow. */
const VALUE_VISIBLE = ["flex", "hidden @sm:flex", "hidden @lg:flex"]

/**
 * The workloads that reported metrics, every service's in one list: its health, where it runs and
 * the first numbers of its Infrastructure tab. A row opens the workload's page.
 */
function Workloads({ className }: { className?: string }) {
	const fleet = useGcpFleet()
	const [chosen, setChosen] = useState<GcpInfraServiceId | "all">("all")
	if (fleet === null) return <Skeleton className={cn("h-40 rounded-md", className)} />

	const services = fleet === "failed" ? [] : fleet.filter(({ workloads }) => workloads.length > 0)
	// A service that stopped reporting takes its chip with it.
	const service = services.some((entry) => entry.service === chosen) ? chosen : "all"
	const all = services.flatMap(({ service, workloads }) =>
		workloads.map((workload) => ({ service, workload })),
	)
	const rows = all
		.filter((row) => service === "all" || row.service === service)
		.toSorted(
			(a, b) =>
				TONE_ORDER.indexOf(gcpWorkloadTone(a.workload)) -
					TONE_ORDER.indexOf(gcpWorkloadTone(b.workload)) ||
				gcpWorkloadName(a.service, a.workload.keys).localeCompare(
					gcpWorkloadName(b.service, b.workload.keys),
				),
		)
	// One project says nothing on every row; several tell the rows apart.
	const manyProjects =
		new Set(all.map((row) => gcpWorkloadProject(row.service, row.workload.keys))).size > 1

	return (
		<Panel className={cn("@container border-border/60", className)}>
			<PanelHeader className="gap-2 border-border/60 pr-2.5">
				<div className="flex min-w-0 flex-1 items-baseline gap-3">
					<h3 className="text-sm font-semibold">Workloads</h3>
					<span className="truncate text-2xs text-muted-foreground">last 24h</span>
				</div>
				{services.length > 1 ? (
					<ToggleGroup
						connected={false}
						size="xs"
						aria-label="Filter workloads by Google Cloud service"
						value={[service]}
						// Pressing the active chip again unpresses it, which falls back to "All".
						onValueChange={(values) =>
							setChosen(services.find((entry) => entry.service === values[0])?.service ?? "all")
						}
						className="gap-1.5"
					>
						<CountChip value="all" label="All" count={all.length} />
						{services.map((entry) => (
							<CountChip
								key={entry.service}
								value={entry.service}
								label={GCP_INFRA_SERVICES[entry.service].title}
								count={entry.workloads.length}
							/>
						))}
					</ToggleGroup>
				) : null}
			</PanelHeader>
			{rows.length === 0 ? (
				<EmptyMessage className="px-3 py-10">
					{fleet === "failed"
						? "Not available right now."
						: "No workload reported metrics in 24 hours."}
				</EmptyMessage>
			) : (
				<div className="max-h-[22rem] overflow-y-auto overscroll-contain">
					{rows.map(({ service, workload }) => {
						const tone = gcpWorkloadTone(workload)
						return (
							<Link
								key={`${service}\u0000${workload.keys.join("\u0000")}`}
								to="/infra/gcp/$service/$name"
								params={{ service, name: workload.keys[0] }}
								// The page opens on the window these numbers are from.
								search={{ ...gcpWorkloadSearch(service, workload.keys), timePreset: WINDOW }}
								className="group flex items-center gap-3 border-b border-border/40 px-4 py-2.5 transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
							>
								<StatusDot tone={tone === "neutral" ? "ok" : tone} />
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<TruncatedText className="text-xs font-medium text-foreground group-hover:text-primary">
										{gcpWorkloadName(service, workload.keys)}
									</TruncatedText>
									<TruncatedText className="text-2xs text-muted-foreground">
										{[
											GCP_INFRA_SERVICES[service].title,
											gcpWorkloadLocation(service, workload.keys),
											manyProjects
												? gcpWorkloadProject(service, workload.keys)
												: undefined,
										]
											.filter(Boolean)
											.join(" · ")}
									</TruncatedText>
								</div>
								{GCP_INFRA_COLUMNS[service].slice(0, VALUES_SHOWN).map((spec, index) => (
									<div
										key={spec.label}
										className={cn(
											"w-24 shrink-0 flex-col gap-0.5 text-right",
											VALUE_VISIBLE[index],
										)}
									>
										<span
											className={cn(
												"text-xs font-medium tabular-nums",
												gcpValueClass(spec, workload.values[index]),
											)}
										>
											{formatGcpValue(spec.format, workload.values[index])}
										</span>
										<span className="text-2xs text-muted-foreground">{spec.label}</span>
									</div>
								))}
							</Link>
						)
					})}
				</div>
			)}
		</Panel>
	)
}

/** The types listed in the card; the Resources tab has the rest. */
const TYPES_SHOWN = 8

/** The inventory by type, each a way into the Infrastructure page's Resources tab. */
function Resources({ className }: { className?: string }) {
	const inventory = useGcpInventory()
	if (inventory === null) return <Skeleton className={cn("h-40 rounded-md", className)} />
	const types = inventory === "failed" ? [] : inventory.types.toSorted((a, b) => b.count - a.count)
	return (
		<Panel className={cn("h-fit border-border/60", className)}>
			<PanelHeader
				className="border-border/60"
				action={<span className="text-2xs text-muted-foreground">listed hourly</span>}
			>
				<h3 className="text-sm font-semibold">Resources</h3>
			</PanelHeader>
			{types.length === 0 ? (
				<p className="px-4 py-3 text-xs text-muted-foreground">
					{inventory === "failed" ? "Not available right now" : "Listed within an hour of setup"}
				</p>
			) : (
				<ul className="flex flex-col px-2 py-1.5">
					{types.slice(0, TYPES_SHOWN).map(({ assetType, count }) => (
						<li key={assetType}>
							<Link
								to="/infra/gcp"
								search={{ tab: GCP_RESOURCES_TAB, type: assetType }}
								className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
							>
								<TruncatedText>{gcpAssetTypeLabel(assetType)}</TruncatedText>
								<span className="shrink-0 tabular-nums text-muted-foreground">
									{formatNumber(count)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
			{inventory === "failed" || inventory.total === 0 ? null : (
				<footer className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
					<span>
						{formatNumber(inventory.total)} in {countLabel(inventory.projects, "project")}
					</span>
					<Link
						to="/infra/gcp"
						search={{ tab: GCP_RESOURCES_TAB }}
						className="inline-flex shrink-0 items-center gap-1 text-foreground hover:text-primary"
					>
						{types.length > TYPES_SHOWN
							? `All ${countLabel(types.length, "type")}`
							: "All resources"}
						<ArrowRightIcon size={11} />
					</Link>
				</footer>
			)}
		</Panel>
	)
}
