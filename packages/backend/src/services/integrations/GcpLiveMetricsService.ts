/**
 * Google Cloud Monitoring metrics, read live through Google's Prometheus-compatible API: the query
 * engine's `GcpLiveMetrics` port. A connection with metrics on (its read-only account in place)
 * is a target: a project scope is its project, a folder or organization the active projects
 * Cloud Asset finds under it. Each project is read with its connection's read-only account, one
 * call per metrics scope. What answered is returned; only when nothing did is it a failure.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { EdgeCacheService } from "@maple/cache"
import { GcpConnectors, type GcpConnectorRow } from "@maple/db/tables"
import type { GcpMetricDescriptor, GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import {
	GcpLiveQueryFailedError,
	GcpLiveQueryRejectedError,
	GcpLiveQueryUnavailableError,
} from "@maple/domain/http/gcp-live-query-errors"
import { GcpProjectId, type OrgId } from "@maple/domain/primitives"
import type { GcpLiveMetrics, QueryTenant } from "@maple/query-engine/runtime"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import {
	ActiveMetricDescriptor,
	fetchMapleAccessToken,
	getMetricsScope,
	type GcpApiError,
	type GcpPromQlParams,
	type GcpReader,
	importServiceAccountKey,
	impersonateReader,
	listActiveMetricDescriptorsPage,
	promQlQuery,
	searchProjectsPage,
} from "./gcp/api"
import { describeGcpApiError } from "./gcp/explain"
import { mapGcpResource } from "./gcp/mapping"

/** Google's tokens live 600 s. Three minutes to spare outlast the slowest fan-out. */
const TOKEN_REUSE_MS = 7 * 60_000
const CONCURRENCY = 4
/** The engine has no project picker: past this a query must filter on `project_id`. */
const MAX_PROJECTS = 20
const MAX_SERIES = 500
/** Projects a folder or organization search reads, 500 a page. */
const MAX_PROJECT_PAGES = 4
/** 10,000 descriptors a page; a project rarely fills one. */
const MAX_DESCRIPTOR_PAGES = 5
const HOUR_SECONDS = 3_600
/** Above the default: a miss here costs a Google call, not a row lookup. */
const CACHE_READ_TIMEOUT_MS = 250
const API_ERROR = "@maple/api/integrations/GcpApiError"

const isProjectId = Schema.is(GcpProjectId)

type Connector = Pick<GcpConnectorRow, "id" | "scopeType" | "scopeId" | "projectId" | "lastMetricsReceivedAt">
type Failure = GcpLiveQueryFailedError["failures"][number]
type Port = GcpLiveMetrics<QueryTenant>
interface Target {
	readonly projectId: GcpProjectId
	readonly connector: Connector
}

const scopeName = (connector: Connector) => `${connector.scopeType}s/${connector.scopeId}`

/** A project's metrics scope: its number, and the numbers of the projects it reads, itself included. */
const MetricsScope = Schema.Struct({ number: Schema.String, monitored: Schema.Array(Schema.String) })

const nothingRead = (failures: ReadonlyArray<Failure>) =>
	new GcpLiveQueryFailedError({
		message: `Google Cloud could not be read. ${failures.map((failure) => `${failure.scope}: ${failure.message}`).join(" ")}`,
		failures,
	})

const mapleSignInFailed = () =>
	new GcpLiveQueryFailedError({
		message:
			"Maple could not sign in to Google Cloud. Try again in a few minutes. If this repeats, write to support@maple.dev.",
		failures: [],
	})

/** Every project's descriptors as one list: a type's resource types and labels are the union. */
const mergeDescriptors = (lists: ReadonlyArray<ReadonlyArray<GcpMetricDescriptor>>) => {
	const merged = new Map<
		string,
		{ first: GcpMetricDescriptor; resources: Set<string>; labels: Set<string> }
	>()
	for (const descriptor of lists.flat()) {
		const entry = merged.get(descriptor.type)
		if (entry === undefined) {
			merged.set(descriptor.type, {
				first: descriptor,
				resources: new Set(descriptor.monitoredResourceTypes),
				labels: new Set(descriptor.labels),
			})
			continue
		}
		for (const resource of descriptor.monitoredResourceTypes) entry.resources.add(resource)
		for (const label of descriptor.labels) entry.labels.add(label)
	}
	return [...merged.values()]
		.map(({ first, resources, labels }): GcpMetricDescriptor => ({
			...first,
			monitoredResourceTypes: [...resources].sort(),
			labels: [...labels].sort(),
		}))
		.sort((a, b) => a.type.localeCompare(b.type))
}

export class GcpLiveMetricsService extends Context.Service<GcpLiveMetricsService, Port>()(
	"@maple/api/services/GcpLiveMetricsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const edgeCache = yield* EdgeCacheService
			// A failed connector read is a defect: the port has no persistence error.
			const dbExecute = makeDbExecute(database, "GcpLiveMetricsService", (error) => error)

			const signingKey = Option.match(env.MAPLE_GCP_SERVICE_ACCOUNT_KEY, {
				onNone: () =>
					Effect.fail(
						new GcpLiveQueryUnavailableError({
							message:
								"Google Cloud metrics are not available on this Maple deployment: it has no Google service account key (MAPLE_GCP_SERVICE_ACCOUNT_KEY).",
						}),
					),
				onSome: Effect.succeed,
			})

			// Tokens are kept for the isolate's lifetime. Only settled values are kept: a pending
			// sign-in shared across requests would resume in another request's I/O context.
			let mapleToken: { readonly token: Redacted.Redacted<string>; readonly until: number } | undefined
			const readers = new Map<Connector["id"], { readonly reader: GcpReader; readonly until: number }>()

			/** A connector's reader. Its own failure is a `GcpApiError`; Maple's sign-in fails the query. */
			const readerFor = Effect.fnUntraced(function* (
				key: Redacted.Redacted<string>,
				connector: Connector,
			) {
				const now = yield* Clock.currentTimeMillis
				const cached = readers.get(connector.id)
				if (cached !== undefined && cached.until > now) return cached.reader
				if (mapleToken === undefined || mapleToken.until <= now) {
					const token = yield* importServiceAccountKey(key).pipe(
						Effect.flatMap((signer) => fetchMapleAccessToken(httpClient, signer, now)),
						Effect.tapError((error) =>
							Effect.logError("gcp sign-in as Maple failed", { error: error.message }),
						),
						Effect.mapError(mapleSignInFailed),
					)
					mapleToken = { token, until: now + TOKEN_REUSE_MS }
				}
				const reader = yield* impersonateReader(httpClient, mapleToken.token, connector)
				readers.set(connector.id, { reader, until: now + TOKEN_REUSE_MS })
				return reader
			})

			const searchProjects = Effect.fnUntraced(function* (
				key: Redacted.Redacted<string>,
				connector: Connector,
			) {
				const reader = yield* readerFor(key, connector)
				// The id is validated when the connector is created; encoding keeps it inside the path.
				const scope = `${connector.scopeType}s/${encodeURIComponent(connector.scopeId)}`
				const projects: Array<GcpProjectId> = []
				let pageToken: string | undefined
				for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
					const body = yield* searchProjectsPage(httpClient, reader, scope, pageToken)
					for (const result of body.results ?? []) {
						const projectId = mapGcpResource(result)?.projectId
						// A project pending deletion answers nothing but errors.
						if ((result.state ?? "ACTIVE") === "ACTIVE" && isProjectId(projectId))
							projects.push(projectId)
					}
					pageToken = body.nextPageToken
					if (pageToken === undefined) break
				}
				return projects
			})

			/**
			 * Every project the org's metrics-on connections reach, each with the connection that
			 * reads it, and the connections whose projects could not be listed.
			 */
			const targetsOf = Effect.fnUntraced(function* (orgId: OrgId, key: Redacted.Redacted<string>) {
				const connectors = yield* dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select("id", "scopeType", "scopeId", "projectId", "lastMetricsReceivedAt")
							.where(($) => [$.orgId.eq(orgId), $.appliedMetricsEnabled.eq(true)])
							.orderBy(($) => [
								[$.createdAt, "asc"],
								[$.id, "asc"],
							]),
					),
				).pipe(Effect.orDie)
				if (connectors.length === 0) {
					return yield* new GcpLiveQueryUnavailableError({
						message: "Connect Google Cloud with metrics on to query Google Cloud metrics.",
					})
				}
				// One connection at a time, so a cold isolate signs in as Maple once.
				const listed = yield* Effect.forEach(connectors, (connector) =>
					connector.scopeType === "project"
						? Effect.succeed({ connector, projects: [connector.projectId] })
						: edgeCache
								.getOrCompute(
									{
										bucket: "gcp-projects",
										key: `${orgId}:${connector.id}`,
										ttlSeconds: HOUR_SECONDS,
										readTimeoutMs: CACHE_READ_TIMEOUT_MS,
										schema: Schema.Array(GcpProjectId),
									},
									searchProjects(key, connector),
								)
								.pipe(
									Effect.map(({ value }) => ({ connector, projects: value })),
									Effect.catchTag(API_ERROR, (error) =>
										Effect.succeed({
											connector,
											projects: [],
											failure: {
												scope: scopeName(connector),
												message: describeGcpApiError(error, connector, "live"),
											},
										}),
									),
								),
				)
				// Overlapping connections read a project through the oldest.
				const projects = new Map<string, Target>()
				for (const { connector, projects: ids } of listed) {
					for (const projectId of ids) {
						if (!projects.has(projectId)) projects.set(projectId, { projectId, connector })
					}
				}
				return {
					projects,
					failures: listed.flatMap((entry) => ("failure" in entry ? [entry.failure] : [])),
				}
			})

			/** Signs each connection in once, so one that cannot fails once, not once per project. */
			const signIn = Effect.fnUntraced(function* (
				key: Redacted.Redacted<string>,
				targets: ReadonlyArray<Target>,
			) {
				const signedIn = new Map<Connector, GcpReader>()
				const failures: Array<Failure> = []
				for (const connector of new Set(targets.map((target) => target.connector))) {
					const reader = yield* readerFor(key, connector).pipe(
						Effect.catchTag(API_ERROR, (error) => {
							failures.push({
								scope: scopeName(connector),
								message: describeGcpApiError(error, connector, "live"),
							})
							return Effect.succeed(undefined)
						}),
					)
					if (reader !== undefined) signedIn.set(connector, reader)
				}
				return {
					reads: targets.flatMap((target) => {
						const reader = signedIn.get(target.connector)
						return reader === undefined ? [] : [{ ...target, reader }]
					}),
					failures,
				}
			})

			const projectFailure = (target: Target, error: GcpApiError): Failure => ({
				scope: `projects/${target.projectId}`,
				message: describeGcpApiError(error, target.connector, "live"),
			})

			/** Partial answers have no warnings channel: the failures go to the span and the log. */
			const recordFailures = (failures: ReadonlyArray<Failure>) => {
				const [first] = failures
				return first === undefined
					? Effect.void
					: Effect.annotateCurrentSpan({
							"maple.gcp.failed_projects": failures.length,
							"maple.gcp.failure": first.message,
						}).pipe(
							Effect.andThen(Effect.logWarning("gcp live read failed in part", { failures })),
						)
			}

			/** The projects a query reads: the ones it names, else all, at most `MAX_PROJECTS`. */
			const selectTargets = Effect.fnUntraced(function* (
				targets: Effect.Success<ReturnType<typeof targetsOf>>,
				requested: ReadonlyArray<string> | undefined,
			) {
				const all = [...targets.projects.values()].sort((a, b) =>
					a.projectId.localeCompare(b.projectId),
				)
				if (requested !== undefined) {
					const unknown = requested.filter((projectId) => !targets.projects.has(projectId))
					if (unknown.length > 0) {
						// A connection whose projects could not be listed may hold them.
						if (targets.failures.length > 0) return yield* nothingRead(targets.failures)
						return yield* new GcpLiveQueryRejectedError({
							message: `Not among the projects this organization's Google Cloud connections can read: ${unknown.join(", ")}.`,
							reason: "invalid_query",
						})
					}
					return all.filter((target) => requested.includes(target.projectId))
				}
				if (all.length > MAX_PROJECTS) {
					const named = all.slice(0, 5).map((target) => target.projectId)
					return yield* new GcpLiveQueryRejectedError({
						message: `The Google Cloud connections reach ${all.length} projects, and one query reads at most ${MAX_PROJECTS}. Filter on project_id to choose them, e.g. ${named.join(", ")}.`,
						reason: "too_many_projects",
					})
				}
				return all
			})

			const runQuery = Effect.fnUntraced(function* (
				orgId: OrgId,
				requested: ReadonlyArray<string> | undefined,
				params: GcpPromQlParams,
			) {
				const key = yield* signingKey
				const targets = yield* targetsOf(orgId, key)
				const selected = yield* selectTargets(targets, requested)
				yield* Effect.annotateCurrentSpan({ "maple.gcp.project_count": selected.length })
				const signedIn = yield* signIn(key, selected)

				// A query on a project reads its whole metrics scope, so a target that another target's
				// scope holds is answered through that one, not read twice.
				const scoped = yield* Effect.forEach(
					signedIn.reads,
					(target) =>
						edgeCache
							.getOrCompute(
								{
									bucket: "gcp-metrics-scopes",
									key: `${orgId}:${target.projectId}`,
									ttlSeconds: HOUR_SECONDS,
									readTimeoutMs: CACHE_READ_TIMEOUT_MS,
									schema: MetricsScope,
								},
								getMetricsScope(httpClient, target.reader, target.projectId),
							)
							.pipe(
								Effect.map(({ value }) => ({ ...target, scope: value })),
								Effect.catchTag(API_ERROR, (error) =>
									Effect.succeed({ ...target, failure: projectFailure(target, error) }),
								),
							),
					{ concurrency: CONCURRENCY },
				)
				const withScope = scoped.flatMap((target) => ("scope" in target ? [target] : []))
				const covered = new Set<string>()
				const reads: typeof withScope = []
				// Widest scopes first.
				for (const target of withScope.sort(
					(a, b) => b.scope.monitored.length - a.scope.monitored.length,
				)) {
					if (covered.has(target.scope.number)) continue
					for (const number of target.scope.monitored) covered.add(number)
					reads.push(target)
				}

				let seriesCount = 0
				const answers = yield* Effect.forEach(
					reads,
					(read) =>
						promQlQuery(httpClient, read.reader, read.projectId, params).pipe(
							// Checked as each project answers, so a broad query stops early.
							Effect.flatMap((series) => {
								seriesCount += series.length
								return seriesCount > MAX_SERIES
									? Effect.fail(
											new GcpLiveQueryRejectedError({
												message: `The query returned more than ${MAX_SERIES} series across its projects. Narrow the query or group by fewer labels.`,
												reason: "too_many_series",
											}),
										)
									: Effect.succeed({ read, series })
							}),
							Effect.catchTag(API_ERROR, (error) =>
								Effect.succeed({ read, failure: projectFailure(read, error) }),
							),
						),
					{ concurrency: CONCURRENCY },
				)

				const failures = [
					...targets.failures,
					...signedIn.failures,
					...scoped.flatMap((target) => ("failure" in target ? [target.failure] : [])),
					...answers.flatMap((answer) => ("failure" in answer ? [answer.failure] : [])),
				]
				yield* recordFailures(failures)
				const answered = answers.flatMap((answer) => ("series" in answer ? [answer] : []))
				if (answered.length === 0 && failures.length > 0) return yield* nothingRead(failures)
				const series = answered.flatMap(({ read, series }) =>
					series.map((one): GcpPromQlSeries => ({
						// Identical label sets from two projects stay apart. A scope of several projects
						// names itself, not a project its series may not come from.
						labels:
							one.labels.project_id === undefined
								? {
										...one.labels,
										[read.scope.monitored.length > 1 ? "metrics_scope" : "project_id"]:
											read.projectId,
									}
								: one.labels,
						points: one.points,
					})),
				)
				yield* Effect.annotateCurrentSpan({ "maple.gcp.series_count": series.length })
				return series
			})

			const listDescriptors = Effect.fnUntraced(function* (reader: GcpReader, projectId: GcpProjectId) {
				const descriptors: Array<GcpMetricDescriptor> = []
				let pageToken: string | undefined
				for (let page = 0; page < MAX_DESCRIPTOR_PAGES; page++) {
					const body = yield* listActiveMetricDescriptorsPage(
						httpClient,
						reader,
						projectId,
						pageToken,
					)
					descriptors.push(...body.descriptors)
					pageToken = body.nextPageToken
					if (pageToken === undefined) break
				}
				return descriptors
			})

			const listMetrics = Effect.fn("GcpLiveMetrics.listMetrics")(function* (tenant: QueryTenant) {
				const key = yield* signingKey
				const targets = yield* targetsOf(tenant.orgId, key)
				// Discovery has no `project_id` filter to narrow it: past the cap, the first projects speak.
				const selected = [...targets.projects.values()]
					.sort((a, b) => a.projectId.localeCompare(b.projectId))
					.slice(0, MAX_PROJECTS)
				yield* Effect.annotateCurrentSpan({ "maple.gcp.project_count": selected.length })
				const signedIn = yield* signIn(key, selected)
				const listed = yield* Effect.forEach(
					signedIn.reads,
					(target) =>
						edgeCache
							.getOrCompute(
								{
									bucket: "gcp-metric-descriptors",
									key: `${tenant.orgId}:${target.projectId}`,
									ttlSeconds: HOUR_SECONDS,
									readTimeoutMs: CACHE_READ_TIMEOUT_MS,
									schema: Schema.Array(ActiveMetricDescriptor),
								},
								listDescriptors(target.reader, target.projectId),
							)
							.pipe(
								Effect.map(({ value }) => ({ descriptors: value })),
								Effect.catchTag(API_ERROR, (error) =>
									Effect.succeed({ failure: projectFailure(target, error) }),
								),
							),
					{ concurrency: CONCURRENCY },
				)
				const failures = [
					...targets.failures,
					...signedIn.failures,
					...listed.flatMap((entry) => ("failure" in entry ? [entry.failure] : [])),
				]
				yield* recordFailures(failures)
				const lists = listed.flatMap((entry) => ("descriptors" in entry ? [entry.descriptors] : []))
				if (lists.length === 0 && failures.length > 0) return yield* nothingRead(failures)
				return mergeDescriptors(lists)
			})

			return {
				queryRange: Effect.fn("GcpLiveMetrics.queryRange")(function* (
					tenant: QueryTenant,
					request: Parameters<Port["queryRange"]>[1],
				) {
					return yield* runQuery(tenant.orgId, request.projects, {
						query: request.query,
						start: request.startSeconds,
						end: request.endSeconds,
						step: request.stepSeconds,
					})
				}),
				queryInstant: Effect.fn("GcpLiveMetrics.queryInstant")(function* (
					tenant: QueryTenant,
					request: Parameters<Port["queryInstant"]>[1],
				) {
					return yield* runQuery(tenant.orgId, request.projects, {
						query: request.query,
						time: request.timeSeconds,
					})
				}),
				listMetrics,
				describeMetric: Effect.fn("GcpLiveMetrics.describeMetric")(function* (
					tenant: QueryTenant,
					metricType: string,
				) {
					const metrics = yield* listMetrics(tenant)
					return metrics.find((metric) => metric.type === metricType)
				}),
			} satisfies Port
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
