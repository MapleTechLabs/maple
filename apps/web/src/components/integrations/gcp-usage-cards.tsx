import type React from "react"
import { Link } from "@tanstack/react-router"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { GCP_INFRA_SERVICES } from "@maple/domain/gcp-infra"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { countLabel, formatNumber } from "@maple/ui/lib/format"

import { StatRail, StatRailItem, StatRailItemSkeleton } from "@/components/common/stat-rail"
import { gcpFleet } from "@/components/infra/gcp/tabs"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	gcpInfraFleetResultAtom,
	getCustomChartTimeSeriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

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

/** The reporting services: what the Infrastructure page's band counts, over the page's window. */
function useGcpWorkloads() {
	const data = useEffectiveTimeRange(undefined, undefined, WINDOW)
	return loaded(useAtomValue(gcpInfraFleetResultAtom({ data })), (fleet) =>
		gcpWorkloadCounts(gcpFleet(fleet.services)),
	)
}

/** The inventory's totals: the read behind the Infrastructure page's Resources tab. */
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
			types: response.types.length,
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
 * The connected state's numbers at a glance, like the Cloudflare page's, summed over every
 * connection: forwarded log entries and how many of them are errors, workloads reporting metrics,
 * and the resource inventory. Each number comes from a read another page already makes. A
 * capability shows its tiles once it has delivered, so the row is always full: the one that
 * delivers alone gets a third tile of its own. A tile whose read fails says so and the others stay.
 */
export function GcpUsageBand({ connectors }: { connectors: ReadonlyArray<V2GcpConnector> }) {
	const logs = connectors.some((connector) => connector.last_log_received_at !== null)
	const metrics = connectors.some((connector) => connector.last_metrics_received_at !== null)
	if (!logs && !metrics) return null
	return (
		<div className="flex flex-col gap-2">
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
			{metrics ? <WorkloadServices /> : null}
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
	const workloads = useGcpWorkloads()
	const inventory = useGcpInventory()
	return (
		<>
			<Tile
				eyebrow="Workloads · 24h"
				read={workloads}
				className={alone ? FIRST_OF_THREE : LAST_ROW}
				value={(services) => services.reduce((sum, { count }) => sum + count, 0)}
				caption={(services) =>
					services.length === 0
						? "No metrics in 24 hours"
						: `In ${countLabel(services.length, "Google Cloud service")}`
				}
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
							? `Of ${countLabel(types, "type")}`
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

/** Workloads reporting metrics per service, each a way into its Infrastructure tab. */
function WorkloadServices() {
	const workloads = useGcpWorkloads()
	if (workloads === null || workloads === "failed" || workloads.length === 0) return null
	return (
		<nav
			aria-label="Workloads by service"
			className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border bg-card px-5 py-2.5 text-xs"
		>
			<span className="text-2xs font-medium text-muted-foreground">
				Workloads by Google Cloud service
			</span>
			{workloads.map(({ service, count }) => (
				<Link
					key={service}
					to="/infra/gcp"
					search={{ tab: service }}
					className="group inline-flex items-baseline gap-1.5 whitespace-nowrap"
				>
					<span className="underline decoration-border underline-offset-4 group-hover:decoration-foreground">
						{GCP_INFRA_SERVICES[service].title}
					</span>
					<span className="font-mono text-muted-foreground tabular-nums">{count}</span>
				</Link>
			))}
		</nav>
	)
}
