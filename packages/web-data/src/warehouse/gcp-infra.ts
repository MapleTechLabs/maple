import { Effect, Schema } from "effect"
import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SOURCE_IDS } from "@maple/domain/gcp-infra"
import {
	GcpCloudSqlInstanceRequest,
	GcpCloudSqlStatementSpansRequest,
	GcpInfraMetricsRequest,
	GcpInfraPresenceRequest,
	GcpInfraSparklinesRequest,
	GcpInfraTimeseriesRequest,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"
import { getServiceDbQuerySummary } from "./service-map"

/** /infra/gcp data access over the `gcp.*` metrics the Google Cloud poller stores. */

const WindowInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
})

const MetricsInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	service: Schema.Literals(GCP_INFRA_SERVICE_IDS),
})

const TimeseriesInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	bucketSeconds: Schema.Number,
	source: Schema.Literals(GCP_INFRA_SOURCE_IDS),
	keys: Schema.Array(Schema.String),
})

const SparklinesInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	bucketSeconds: Schema.Number,
	services: Schema.Array(Schema.Literals(GCP_INFRA_SERVICE_IDS)),
})

const CloudSqlInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	/** The instance's identity values, as `TimeseriesInputSchema`'s. */
	keys: Schema.Array(Schema.String),
})

/** The services with a metric in the window. */
const getGcpInfraPresence = Effect.fn("QueryEngine.getGcpInfraPresence")(function* ({
	data,
}: {
	data: (typeof WindowInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(WindowInputSchema, data, "getGcpInfraPresence")
	const result = yield* runWarehouseQuery("gcpInfraPresence", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.gcpInfraPresence({
				payload: new GcpInfraPresenceRequest(input),
			})
		}),
	)
	return { services: result.services }
})

/** One service's metrics: a point per workload, metric and label value. */
const getGcpInfraMetrics = Effect.fn("QueryEngine.getGcpInfraMetrics")(function* ({
	data,
}: {
	data: (typeof MetricsInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(MetricsInputSchema, data, "getGcpInfraMetrics")
	const result = yield* runWarehouseQuery("gcpInfraMetrics", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.gcpInfraMetrics({
				payload: new GcpInfraMetricsRequest(input),
			})
		}),
	)
	return { points: result.data }
})

/**
 * Every reporting service's metrics at once: what the summary band, the tabs and the
 * Infrastructure overview read. One presence probe, then one query per reporting service; a
 * service whose query fails is returned empty and `failed`, so the others still show.
 */
export const getGcpInfraFleet = Effect.fn("QueryEngine.getGcpInfraFleet")(function* ({
	data,
}: {
	data: (typeof WindowInputSchema)["Encoded"]
}) {
	const { services } = yield* getGcpInfraPresence({ data })
	return {
		services: yield* Effect.forEach(
			services,
			(service) =>
				getGcpInfraMetrics({ data: { ...data, service } }).pipe(
					Effect.map(({ points }) => ({ service, points, failed: false })),
					Effect.orElseSucceed(() => ({ service, points: [], failed: true })),
				),
			{ concurrency: "unbounded" },
		),
	}
})

/** One workload's metrics over time: a point per bucket, metric and label value. */
export const getGcpInfraTimeseries = Effect.fn("QueryEngine.getGcpInfraTimeseries")(function* ({
	data,
}: {
	data: (typeof TimeseriesInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getGcpInfraTimeseries")
	const result = yield* runWarehouseQuery("gcpInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.gcpInfraTimeseries({
				payload: new GcpInfraTimeseriesRequest(input),
			})
		}),
	)
	return { points: result.data }
})

/**
 * The row sparklines of one list view, one query per service. A service whose query fails is
 * returned empty: its rows draw no sparkline, and the list still shows.
 */
export const getGcpInfraSparklines = Effect.fn("QueryEngine.getGcpInfraSparklines")(function* ({
	data,
}: {
	data: (typeof SparklinesInputSchema)["Encoded"]
}) {
	const { services, ...input } = yield* decodeInput(SparklinesInputSchema, data, "getGcpInfraSparklines")
	return {
		services: yield* Effect.forEach(
			services,
			(service) =>
				runWarehouseQuery("gcpInfraSparklines", () =>
					Effect.gen(function* () {
						const client = yield* MapleInternalHttp
						return yield* client.queryEngine.gcpInfraSparklines({
							payload: new GcpInfraSparklinesRequest({ ...input, service }),
						})
					}),
				).pipe(
					Effect.map((result) => ({ service, points: result.data })),
					Effect.orElseSucceed(() => ({ service, points: [] })),
				),
			{ concurrency: "unbounded" },
		),
	}
})

/** A Cloud SQL instance's statements by total execution time, as the poller stored Query Insights'. */
export const getGcpCloudSqlTopQueries = Effect.fn("QueryEngine.getGcpCloudSqlTopQueries")(function* ({
	data,
}: {
	data: (typeof CloudSqlInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(CloudSqlInputSchema, data, "getGcpCloudSqlTopQueries")
	const result = yield* runWarehouseQuery("gcpCloudSqlTopQueries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.gcpCloudSqlTopQueries({
				payload: new GcpCloudSqlInstanceRequest(input),
			})
		}),
	)
	return { statements: result.data }
})

const StatementSpansInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	/** The instance's databases, as `db.namespace`; at least one. */
	databases: GcpCloudSqlStatementSpansRequest.fields.databases,
	/** The traced query keys a statement matched (`tracedQueries[].queryKey`); at least one. */
	queryKeys: GcpCloudSqlStatementSpansRequest.fields.queryKeys,
})

/** The slowest client spans of a statement's traced query keys, each linking to its trace. */
export const getGcpCloudSqlStatementSpans = Effect.fn("QueryEngine.getGcpCloudSqlStatementSpans")(function* ({
	data,
}: {
	data: (typeof StatementSpansInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(StatementSpansInputSchema, data, "getGcpCloudSqlStatementSpans")
	const result = yield* runWarehouseQuery("gcpCloudSqlStatementSpans", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.gcpCloudSqlStatementSpans({
				payload: new GcpCloudSqlStatementSpansRequest(input),
			})
		}),
	)
	return { spans: result.data }
})

const DatabaseInstancesInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	/** A `db.namespace` the traces query. */
	database: Schema.String,
	/** The identity values of each Cloud SQL instance to look in. */
	instances: Schema.Array(Schema.Array(Schema.String)),
})

/**
 * The PostgreSQL instances that hold a database of the traces' name, from the connections the
 * poller stored per database. An instance whose read fails is left out.
 */
export const getGcpCloudSqlInstancesOfDatabase = Effect.fn("QueryEngine.getGcpCloudSqlInstancesOfDatabase")(
	function* ({ data }: { data: (typeof DatabaseInstancesInputSchema)["Encoded"] }) {
		const { database, instances, ...window } = yield* decodeInput(
			DatabaseInstancesInputSchema,
			data,
			"getGcpCloudSqlInstancesOfDatabase",
		)
		const owners = yield* Effect.forEach(
			instances,
			(keys) =>
				runWarehouseQuery("gcpCloudSqlDatabases", () =>
					Effect.gen(function* () {
						const client = yield* MapleInternalHttp
						return yield* client.queryEngine.gcpCloudSqlDatabases({
							payload: new GcpCloudSqlInstanceRequest({ ...window, keys }),
						})
					}),
				).pipe(
					Effect.map((result) => (result.databases.includes(database) ? [keys] : [])),
					Effect.orElseSucceed(() => []),
				),
			{ concurrency: 4 },
		)
		return { instances: owners.flat() }
	},
)

/** Cloud SQL's own databases, and PostgreSQL's templates: no application queries them. */
const SYSTEM_DATABASES = new Set(["cloudsqladmin", "template0", "template1", "postgres"])

/**
 * A PostgreSQL instance as the traces see it: its databases, from the connections the poller
 * stored per database in the window, and the query shapes the traces recorded against each one
 * (`db.namespace`). `services` is the most services any one database had calling it.
 */
export const getGcpCloudSqlTraceSide = Effect.fn("QueryEngine.getGcpCloudSqlTraceSide")(function* ({
	data,
}: {
	data: (typeof CloudSqlInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(CloudSqlInputSchema, data, "getGcpCloudSqlTraceSide")
	const result = yield* runWarehouseQuery("gcpCloudSqlDatabases", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.gcpCloudSqlDatabases({
				payload: new GcpCloudSqlInstanceRequest(input),
			})
		}),
	)
	const databases = result.databases.filter((database) => !SYSTEM_DATABASES.has(database))
	// A database whose read fails is left out; the others still show.
	const summaries = (yield* Effect.forEach(
		databases,
		(database) =>
			getServiceDbQuerySummary({
				data: {
					dbSystem: "postgresql",
					dbNamespace: database,
					startTime: input.startTime,
					endTime: input.endTime,
					topN: 50,
				},
			}).pipe(Effect.orElseSucceed(() => null)),
		{ concurrency: 4 },
	)).filter((summary) => summary !== null)
	return {
		databases,
		tracedQueries: summaries.flatMap((summary) => summary.topQueries),
		services: Math.max(0, ...summaries.map((summary) => summary.summary?.activeServiceCount ?? 0)),
	}
})
