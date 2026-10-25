import { gcpCloudSqlInstances } from "../../../../components/infra/gcp/inventory"
import {
	gcpListRows,
	gcpListScope,
	gcpRequestedView,
	gcpSparklineBucketSeconds,
	gcpWindowSeconds,
	gcpSparks,
	NO_GCP_SPARKS,
} from "../../../../components/infra/gcp/list-model"
import { gcpInfraNotice, gcpInfraSetupPending, type GcpView } from "../../../../components/infra/gcp/tabs"
import { gcpMetricsState } from "../../../../components/integrations/gcp-connector-state"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { TimeWindow } from "../../../../data/time-range"
import type { FleetRead, GcpStatus, Resources } from "../data"
import type { Model } from "./model"

// The page's derivations over its reads (`GcpPage`, `GcpInfra` and `GcpListPage`).

/** `Result.builder(...).onSuccess(...).orElse(...)`: a settled success, refreshing included. */
export const successOf = <A, E>(data: AsyncData.AsyncData<A, E>): A | null =>
	AsyncData.isSuccess(data) || AsyncData.isRefreshing(data)
		? Option.getOrNull(AsyncData.getData(data))
		: null

export const statusOf = (model: Model): GcpStatus | null => successOf(model.status.data)

/** The connections that collect metrics; none when metrics are off on all of them. */
export const metricsConnectors = (status: GcpStatus) =>
	status.connectors.filter((connector) => connector.metrics_enabled)

/** While a connection waits on its script or its first read, the status is re-read faster. */
export const isSettling = (status: GcpStatus, nowMs: number): boolean =>
	status.connectors.some((connector) => {
		const kind = gcpMetricsState(connector, nowMs).kind
		return kind === "setup-pending" || kind === "setup-running" || kind === "waiting"
	})

export type PageState =
	| Readonly<{ _tag: "NotConnected" }>
	| Readonly<{ _tag: "SetupPending" }>
	| Readonly<{ _tag: "Infra"; connectors: ReturnType<typeof metricsConnectors> }>

export const pageStateOf = (status: GcpStatus, nowMs: number): PageState => {
	if (status.connectors.length === 0) return { _tag: "NotConnected" }
	const connectors = metricsConnectors(status)
	if (connectors.length > 0 && gcpInfraSetupPending(connectors, nowMs)) return { _tag: "SetupPending" }
	return { _tag: "Infra", connectors }
}

export const fleetOf = (model: Model): ReadonlyArray<FleetRead> | null => successOf(model.fleet.data)

export const requestedViewOf = (model: Model): GcpView | undefined =>
	gcpRequestedView(model.search.view, model.search.tab)

/** The seconds the fleet was read over; 0 before the window resolves. */
export const windowSecondsOf = (model: Model): number =>
	model.window === null ? 0 : gcpWindowSeconds(model.window.startTime, model.window.endTime)

export const sparksOf = (model: Model) => {
	const window = model.window
	const reads = successOf(model.sparks.data)
	if (window === null || reads === null) return NO_GCP_SPARKS
	return gcpSparks(reads, {
		...window,
		bucketSeconds: gcpSparklineBucketSeconds(window.startTime, window.endTime),
	})
}

const instancesOf = (inventory: Resources | null) =>
	inventory === null ? undefined : gcpCloudSqlInstances(inventory.resources)

/** `gcpListScope` over every row: what the header, band and table show. */
export const listScopeOf = (model: Model, collecting: boolean) => {
	const fleet = fleetOf(model)
	const allRows =
		fleet === null
			? null
			: gcpListRows(
					fleet,
					sparksOf(model),
					windowSecondsOf(model),
					cloudSqlInstancesOf(model, collecting),
				)
	return gcpListScope(
		allRows,
		{ view: requestedViewOf(model), project: model.search.project, region: model.search.region },
		collecting,
	)
}

/** The Cloud SQL inventory's instances, read only while that view shows. */
export const cloudSqlInstancesOf = (model: Model, collecting: boolean) => {
	const fleet = fleetOf(model)
	const scoped = gcpListScope(
		fleet === null ? null : gcpListRows(fleet, NO_GCP_SPARKS, windowSecondsOf(model)),
		{ view: requestedViewOf(model), project: model.search.project, region: model.search.region },
		collecting,
	)
	return scoped.view === "cloudSql" ? instancesOf(successOf(model.cloudSqlInventory.data)) : undefined
}

/** What the connections say, above the lists; `null` while the fleet loads. */
export const noticeOf = (model: Model, connectors: ReturnType<typeof metricsConnectors>) => {
	const fleet = fleetOf(model)
	return fleet === null ? null : gcpInfraNotice(connectors, fleet.length > 0, model.nowMs)
}

export const sparksWindow = (window: TimeWindow) => ({
	...window,
	bucketSeconds: gcpSparklineBucketSeconds(window.startTime, window.endTime),
})
