import { anomalyAffectsServiceHealth } from "@maple/web-data/anomalies/format"
import { rowsToAlertIncidentDocuments } from "@maple/web-data/collections/alerts"
import { AlertSignalType, type AnomalySignalType } from "@maple/domain/http"
import { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { LoadFailure, settleTo } from "@maple/views/data/load-failure"
import { requestKey, type RequestKey } from "@maple/views/data/request-key"
import { Schema, Stream, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import type { CallableTaggedStruct } from "foldkit/schema"
import { alertIncidentCauseLabel, anomalyDirection, type ServiceHealthCause } from "./service-health-rollup"
import { loadAnomalyServiceCounts } from "../../data/anomaly-service-counts"
import { type OrgCollections, orgLive } from "../../data/collections/org-collections"
import { liveQueryStream } from "../../data/live-query"
import { collectionLoadFailed, ENRICHMENT_LOAD_TIMEOUT_MS } from "./collection-load"

// Service health inputs the overview and the services list share: the synced alert incidents, the
// open anomaly counts, and the causes each service row reads from them.

/** The alert-incident fields service health reads (`rowToAlertIncidentDocument`). */
export const HealthIncident = Schema.Struct({
	status: Schema.String,
	groupKey: Schema.NullOr(Schema.String),
	severity: Schema.Literals(["warning", "critical"]),
	/** `uptime` incidents read as a failing check rather than a generic alert. */
	signalType: AlertSignalType,
})
export type HealthIncident = typeof HealthIncident.Type

/** `Failure`: the live alert sync failed or stalled; the page reads it as no incidents. */
export const IncidentsData = AsyncData.Schema(Schema.Array(HealthIncident), Schema.Literal("Unavailable"))
export type IncidentsData = typeof IncidentsData.schema.Type

const AnomalyCountsResult = {
	key: Schema.String,
	result: Schema.Result(Schema.Array(V2AnomalyServiceCount), LoadFailure),
}

/** The messages a page spreads into its union to receive incidents and anomaly counts. */
export const HealthMessages = {
	CompletedFetchAnomalies: AnomalyCountsResult,
	UpdatedIncidents: { orgId: Schema.String, incidents: Schema.Array(HealthIncident) },
	FailedLoadIncidents: { orgId: Schema.String },
}

/** The open anomaly counts read's cache key; it never changes within an org. */
export const anomaliesKey = (orgId: string): RequestKey =>
	requestKey(orgId, "anomalies.serviceCounts", { status: "open" })

/** A page's open anomaly counts read, under its own command name. */
export const fetchAnomaliesCommand = <const Name extends string, const Tag extends string>(
	name: Name,
	completed: CallableTaggedStruct<Tag, typeof AnomalyCountsResult>,
) =>
	Command.define(name, {
		args: { key: Schema.String, refresh: Schema.Boolean },
		messages: [completed],
		execute: ({ key, refresh }) =>
			loadAnomalyServiceCounts(key, { refresh }).pipe(settleTo((result) => completed({ key, result }))),
	})

/** The org's incidents, newest trigger first, reduced to what health reads. */
export const incidentsStream = <M>(
	orgId: string,
	updated: (incidents: ReadonlyArray<HealthIncident>) => M,
): Stream.Stream<M, never, OrgCollections> =>
	orgLive(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ i: set.alertIncidents }).orderBy(({ i }) => i.last_triggered_at, "desc"),
			(rows) =>
				updated(
					Arr.map(rowsToAlertIncidentDocuments(rows), (incident) => ({
						status: incident.status,
						groupKey: incident.groupKey,
						severity: incident.severity,
						signalType: incident.signalType,
					})),
				),
		),
	)

/** Health stops waiting on an alert sync that failed or stalled. */
export const incidentsLoadFailedStream = <M>(
	orgId: string,
	isWaiting: boolean,
	failed: () => M,
): Stream.Stream<M> =>
	isWaiting
		? collectionLoadFailed(`alert_incidents:${orgId}`, failed, ENRICHMENT_LOAD_TIMEOUT_MS)
		: Stream.empty

/** `UpdatedIncidents`: this org's synced incidents; another org's are ignored (`undefined`). */
export const receivedIncidents = (
	orgId: string,
	contextOrgId: string,
	incidents: ReadonlyArray<HealthIncident>,
): IncidentsData | undefined =>
	orgId === contextOrgId ? IncidentsData.Success({ data: incidents }) : undefined

/** `FailedLoadIncidents`: only a still-loading sync for this org fails. */
export const failedIncidents = (
	current: IncidentsData,
	orgId: string,
	contextOrgId: string,
): IncidentsData | undefined =>
	orgId === contextOrgId && AsyncData.isLoading(current)
		? IncidentsData.Failure({ error: "Unavailable" })
		: undefined

const ANOMALY_LABEL = new Map<AnomalySignalType, string>([
	["error_rate", "Error rate anomaly"],
	["latency_p95", "Latency anomaly"],
	["throughput", "Traffic outage"],
	["error_spike", "Error frequency increase"],
	["log_volume", "Log volume anomaly"],
])
const ANOMALY_METRIC = new Map<AnomalySignalType, ServiceHealthCause["metric"]>([
	["error_rate", "error"],
	["latency_p95", "latency"],
	["throughput", "traffic"],
	["log_volume", "error"],
])

/** Every count row is an open incident; a stale or `error_spike` one leaves health alone. */
const affectsHealth = (row: V2AnomalyServiceCount, nowMs: number): boolean =>
	anomalyAffectsServiceHealth(
		{ status: "open", signalType: row.signal_type, lastTriggeredAt: row.last_triggered_at },
		nowMs,
	)

const serviceKey = (name: string, environment: string): string => `${name}\u0000${environment}`

const groupCauses = <A>(
	rows: ReadonlyArray<A>,
	keyOf: (row: A) => string,
	causeOf: (row: A) => ServiceHealthCause,
): Map<string, Array<ServiceHealthCause>> => {
	const byKey = new Map<string, Array<ServiceHealthCause>>()
	Arr.forEach(rows, (row) => {
		const key = keyOf(row)
		const list = byKey.get(key)
		if (list) list.push(causeOf(row))
		else byKey.set(key, [causeOf(row)])
	})
	return byKey
}

/**
 * The causes of each service row: open alert incidents by `groupKey` (the service name), then
 * affecting anomalies by service and environment. Indexed once so each row is a lookup. The services
 * list drops incidents with an empty `groupKey` (`dropEmptyGroupKey`); the overview keeps them.
 */
export const serviceHealthCauses = (
	incidents: ReadonlyArray<HealthIncident>,
	anomalies: ReadonlyArray<V2AnomalyServiceCount>,
	nowMs: number,
	options: { readonly dropEmptyGroupKey: boolean },
): ((serviceName: string, environment: string) => ReadonlyArray<ServiceHealthCause>) => {
	const alertCauses = groupCauses(
		Arr.filter(
			incidents,
			(incident) =>
				incident.status === "open" &&
				incident.groupKey !== null &&
				!(options.dropEmptyGroupKey && incident.groupKey === ""),
		),
		(incident) => incident.groupKey ?? "",
		(incident) => ({ severity: incident.severity, label: alertIncidentCauseLabel(incident.signalType) }),
	)
	const anomalyCauses = groupCauses(
		Arr.filter(anomalies, (row) => affectsHealth(row, nowMs)),
		(row) => serviceKey(row.service_name, row.deployment_env || "unknown"),
		(row) => ({
			severity: row.severity,
			label: ANOMALY_LABEL.get(row.signal_type) ?? "",
			metric: ANOMALY_METRIC.get(row.signal_type),
			direction: anomalyDirection(row.signal_type),
		}),
	)
	return (serviceName, environment) => [
		...(alertCauses.get(serviceName) ?? []),
		...(anomalyCauses.get(serviceKey(serviceName, environment)) ?? []),
	]
}
