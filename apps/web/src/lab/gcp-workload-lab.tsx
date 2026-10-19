import { useMemo, useState } from "react"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { gcpWindowPoints } from "@/components/infra/gcp/charts"
import { gcpCloudSqlView } from "@/components/infra/gcp/cloud-sql-signals"
import { GcpCloudSqlTopQueries } from "@/components/infra/gcp/gcp-cloudsql-top-queries"
import {
	GcpAppWaitCallout,
	GcpCloudSqlChips,
	GcpTraceGapCallout,
	GcpWorkloadHeader,
	GcpWorkloadSignals,
} from "@/components/infra/gcp/gcp-workload-page"
import { GcpWorkloadRail } from "@/components/infra/gcp/gcp-workload-rail"
import { gcpConsoleLinks, gcpExplorerWhere, gcpWorkloadTelemetry } from "@/components/infra/gcp/inventory"
import {
	gcpWorkload,
	gcpWorkloadLocation,
	gcpWorkloadName,
	gcpWorkloadProject,
	gcpWorkloadTone,
} from "@/components/infra/gcp/tabs"
import { gcpRailFacts, gcpTraceGap } from "@/components/infra/gcp/workload-signals"
import { SegmentPivot } from "@/components/infra/primitives/segment-pivot"
import { Result } from "@/lib/effect-atom"
import {
	BUCKET_SECONDS,
	PAGE_LABEL,
	PAGES,
	RANGE,
	WORKLOADS,
	type LabPage,
	type LabWorkload,
} from "./gcp-workload-fixture"

/** The Google Cloud workload page, whole, over fixture series: a Cloud Run burst and a Cloud SQL instance. */
export function GcpWorkloadLab() {
	const [page, setPage] = useState<LabPage>("run")
	return (
		<>
			<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-lg">
				<span className="font-mono text-2xs text-muted-foreground">Google Cloud lab</span>
				<SegmentPivot<LabPage>
					ariaLabel="Lab page"
					options={PAGES.map((value) => ({
						value,
						label: PAGE_LABEL[value],
					}))}
					value={page}
					onChange={setPage}
				/>
			</div>
			<WorkloadPage key={page} workload={WORKLOADS[page]} />
		</>
	)
}

function WorkloadPage({ workload }: { workload: LabWorkload }) {
	const { service, keys, points, resource, tracedErrors, cloudSql } = workload
	const telemetry = gcpWorkloadTelemetry(service, keys)
	const logs = { service: telemetry.logsService, attrs: telemetry.logAttrs }
	const tracedService = tracedErrors === null ? null : telemetry.serviceName
	const gap = useMemo(
		() => gcpTraceGap(service, points, BUCKET_SECONDS, tracedErrors),
		[service, points, tracedErrors],
	)
	const health = gcpWorkloadTone(gcpWorkload(service, keys, gcpWindowPoints(points)))
	const sql = useMemo(
		() =>
			cloudSql === undefined
				? undefined
				: gcpCloudSqlView({ ...cloudSql, points, bucketSeconds: BUCKET_SECONDS }),
		[cloudSql, points],
	)
	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Infrastructure" },
				{ label: "Google Cloud" },
				{ label: gcpWorkloadName(service, keys) },
			]}
			// The route's header: the time controls beside the title. The fixture window stays put.
			time={{ search: {}, defaultPreset: "6h", onChange: () => {}, ...RANGE }}
			rightPanel={
				<GcpWorkloadRail
					service={service}
					project={gcpWorkloadProject(service, keys)}
					location={gcpWorkloadLocation(service, keys)}
					resource={resource}
					facts={sql?.facts ?? gcpRailFacts(service, points, BUCKET_SECONDS)}
					health={sql?.health}
					traced={
						telemetry.traced ? { name: telemetry.serviceName, service: tracedService } : undefined
					}
					logs={logs}
					serviceMap={sql === undefined ? undefined : { focusService: sql.focusService }}
					consoleLinks={gcpConsoleLinks(service, keys)}
					timeSearch={{}}
				/>
			}
			titleContent={
				<GcpWorkloadHeader
					service={service}
					keys={keys}
					health={health}
					databaseVersion={cloudSql?.instance.databaseVersion}
					meta={
						cloudSql === undefined ? undefined : (
							<GcpCloudSqlChips
								keys={keys}
								instance={cloudSql.instance}
								databaseVersion={cloudSql.instance.databaseVersion ?? undefined}
								services={cloudSql.services}
							/>
						)
					}
				/>
			}
			gap="lg"
		>
			<div className="space-y-6">
				{gap === null || tracedService === null || service !== "cloudRun" ? null : (
					<GcpTraceGapCallout
						service={service}
						gap={gap}
						tracedService={tracedService}
						logsService={telemetry.logsService}
					/>
				)}
				{sql === undefined || sql.wait === null ? null : (
					<GcpAppWaitCallout
						wait={sql.wait}
						peak={sql.peak}
						instanceName={gcpWorkloadName(service, keys)}
						timeSearch={{}}
					/>
				)}
				<GcpWorkloadSignals
					service={service}
					points={points}
					range={RANGE}
					where={gcpExplorerWhere(service, keys)}
					timeSearch={{}}
					maxConnections={cloudSql?.instance.maxConnections ?? null}
				>
					{cloudSql === undefined || sql === undefined ? null : (
						<GcpCloudSqlTopQueries
							insights={Result.success({ rows: cloudSql.statements, unavailableReason: null })}
							traced={sql.traced}
						/>
					)}
				</GcpWorkloadSignals>
			</div>
		</DashboardPage>
	)
}
