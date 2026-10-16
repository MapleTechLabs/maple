// Google Cloud on the service map: the workloads a service runs as, in its panel's Infrastructure
// tab, and the Cloud SQL instance a database node lives on. Each links to its page under
// Infrastructure -> Google Cloud. Nothing is read unless a connection collects metrics.

import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { Panel } from "@maple/ui/components/ui/panel"
import { Separator } from "@maple/ui/components/ui/separator"
import { errorRateClass } from "@maple/ui/lib/error-rate"

import { ArrowRightIcon, GoogleCloudIcon } from "@/components/icons"
import { GcpServiceIcon } from "@/components/infra/gcp/gcp-service-icon"
import {
	GCP_CLOUD_SQL_INVENTORY_QUERY,
	gcpCloudSqlInstances,
	gcpWorkloadTelemetry,
	type GcpCloudSqlInstance,
} from "@/components/infra/gcp/inventory"
import {
	GCP_INFRA_COLUMNS,
	NO_GCP_FLEET,
	formatGcpValue,
	gcpFleet,
	gcpWorkloadName,
	gcpWorkloadSearch,
	type GcpWorkload,
} from "@/components/infra/gcp/tabs"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	gcpCloudSqlInstancesOfDatabaseResultAtom,
	gcpInfraFleetResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

interface TimeWindow {
	startTime: string
	endTime: string
}

/** Whether any connection collects metrics; `children` render only then. */
function WhenCollecting({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
	const statusResult = useAtomValue(
		retainedQueryV2("gcpIntegration", "status", { reactivityKeys: ["gcpIntegration"] }),
	)
	const collecting = Result.builder(statusResult)
		.onSuccess((status) => status.connectors.some((connector) => connector.metrics_enabled))
		.orElse(() => false)
	return collecting ? children : fallback
}

/** The fleet's workloads of one service, in the window. */
function useGcpWorkloads({ startTime, endTime }: TimeWindow) {
	const fleetResult = useRefreshableAtomValue(gcpInfraFleetResultAtom({ data: { startTime, endTime } }))
	return Result.builder(fleetResult)
		.onSuccess((response) => gcpFleet(response.services))
		.orElse(() => NO_GCP_FLEET)
}

/**
 * The Google Cloud workloads a traced service runs as (a Cloud Run service, a function, a GKE
 * container, a VM of its name), for its panel's Infrastructure tab. `empty` shows when none does.
 */
export function GcpServiceWorkloads(props: TimeWindow & { serviceName: string; empty: ReactNode }) {
	return (
		<WhenCollecting fallback={props.empty}>
			<GcpServiceWorkloadsData {...props} />
		</WhenCollecting>
	)
}

function GcpServiceWorkloadsData({
	serviceName,
	empty,
	...window
}: TimeWindow & { serviceName: string; empty: ReactNode }) {
	const matches = useGcpWorkloads(window).flatMap(({ service, workloads }) =>
		workloads
			.filter((workload) => {
				const telemetry = gcpWorkloadTelemetry(service, workload.keys)
				return telemetry.traced && telemetry.serviceName === serviceName
			})
			.map((workload) => ({ service, workload })),
	)
	if (matches.length === 0) return empty
	return (
		<div className="space-y-2">
			<Eyebrow as="h4" className="flex items-center gap-1.5">
				<GoogleCloudIcon size={11} />
				Google Cloud
			</Eyebrow>
			<div className="space-y-2">
				{matches.map(({ service, workload }) => (
					<GcpWorkloadRow
						key={`${service}:${workload.keys.join("/")}`}
						service={service}
						workload={workload}
					/>
				))}
			</div>
		</div>
	)
}

/** One workload: its service, name and place, its tab's first four readings, and its page. */
function GcpWorkloadRow({ service, workload }: { service: GcpInfraServiceId; workload: GcpWorkload }) {
	return (
		<Panel padded="sm" className="space-y-2.5">
			<div className="flex items-center gap-2.5">
				{/* A database node matches PostgreSQL instances only. */}
				<GcpServiceIcon
					service={service}
					databaseVersion={service === "cloudSql" ? "POSTGRES" : undefined}
					size="sm"
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-xs font-medium text-foreground">
						{gcpWorkloadName(service, workload.keys)}
					</p>
					<p className="truncate text-3xs text-muted-foreground">
						{[GCP_INFRA_SERVICES[service].title, ...workload.keys.slice(1)].join(" · ")}
					</p>
				</div>
			</div>
			<KeyValueList className="grid grid-cols-2 gap-2 text-3xs">
				{GCP_INFRA_COLUMNS[service].slice(0, 4).map((spec, index) => (
					<KeyValue
						key={spec.label}
						label={spec.label}
						mono
						className="rounded bg-muted/30 px-2 py-1"
					>
						<span
							className={
								spec.format === "errorRate"
									? errorRateClass(workload.values[index] ?? 0)
									: undefined
							}
						>
							{formatGcpValue(spec.format, workload.values[index])}
						</span>
					</KeyValue>
				))}
			</KeyValueList>
			<WorkloadLink service={service} keys={workload.keys} />
		</Panel>
	)
}

function WorkloadLink({ service, keys }: { service: GcpInfraServiceId; keys: ReadonlyArray<string> }) {
	return (
		<Link
			to="/infra/gcp/$service/$name"
			params={{ service, name: keys[0] }}
			search={gcpWorkloadSearch(service, keys)}
			className="inline-flex items-center gap-1 text-3xs text-primary transition-colors hover:text-primary/80"
		>
			View on Google Cloud page <ArrowRightIcon size={10} />
		</Link>
	)
}

/**
 * The Cloud SQL instances a database node lives on, in its panel: matched by the database's name
 * among the PostgreSQL databases the poller saw connections to. MySQL and SQL Server report no
 * databases, so their nodes match nothing.
 */
export function GcpCloudSqlSection(props: TimeWindow & { dbSystem: string; dbNamespace: string }) {
	// `postgres` is the spelling of older instrumentations.
	if ((props.dbSystem !== "postgresql" && props.dbSystem !== "postgres") || props.dbNamespace === "")
		return null
	return (
		<WhenCollecting fallback={null}>
			<GcpCloudSqlSectionData {...props} />
		</WhenCollecting>
	)
}

function GcpCloudSqlSectionData({
	dbNamespace,
	startTime,
	endTime,
}: TimeWindow & { dbSystem: string; dbNamespace: string }) {
	const workloads =
		useGcpWorkloads({ startTime, endTime }).find(({ service }) => service === "cloudSql")?.workloads ??
		NO_WORKLOADS
	if (workloads.length === 0) return null
	return (
		<GcpCloudSqlMatches
			database={dbNamespace}
			workloads={workloads}
			startTime={startTime}
			endTime={endTime}
		/>
	)
}

const NO_WORKLOADS: ReadonlyArray<GcpWorkload> = []
const NO_INSTANCES: ReadonlyArray<GcpCloudSqlInstance> = []

function GcpCloudSqlMatches({
	database,
	workloads,
	startTime,
	endTime,
}: TimeWindow & { database: string; workloads: ReadonlyArray<GcpWorkload> }) {
	const result = useAtomValue(
		gcpCloudSqlInstancesOfDatabaseResultAtom({
			data: { startTime, endTime, database, instances: workloads.map((workload) => workload.keys) },
		}),
	)
	const inventoryResult = useAtomValue(
		retainedInternalQuery("integrations", "gcpResources", {
			query: GCP_CLOUD_SQL_INVENTORY_QUERY,
			reactivityKeys: ["gcpIntegration"],
		}),
	)
	if (!Result.isSuccess(result)) return null
	const owners = result.value.instances.map((keys) => keys.join("/"))
	const matched = workloads.filter((workload) => owners.includes(workload.keys.join("/")))
	// An instance that reports no connections per database can't be matched by name: offer the
	// PostgreSQL instances (or those of an engine the inventory doesn't know) instead, as such.
	const instances = Result.builder(inventoryResult)
		.onSuccess((inventory) => gcpCloudSqlInstances(inventory.resources))
		.orElse(() => NO_INSTANCES)
	const matches =
		matched.length > 0
			? matched
			: workloads.filter((workload) => {
					const version = instances.find(
						(instance) => instance.id === workload.keys[0],
					)?.databaseVersion
					return version == null || version.startsWith("POSTGRES")
				})
	if (matches.length === 0) return null
	return (
		<div className="space-y-3">
			<Separator />
			<Eyebrow as="h4" className="flex items-center gap-1.5">
				<GoogleCloudIcon size={11} />
				Cloud SQL
			</Eyebrow>
			{matched.length > 0 ? null : (
				<p className="text-2xs text-pretty text-muted-foreground">
					Your PostgreSQL instances in Google Cloud. Which one holds {database} isn't known: they
					report no connections per database.
				</p>
			)}
			<div className="space-y-2">
				{matches.map((workload) => (
					<GcpWorkloadRow key={workload.keys.join("/")} service="cloudSql" workload={workload} />
				))}
			</div>
		</div>
	)
}
