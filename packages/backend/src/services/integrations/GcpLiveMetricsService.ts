/**
 * Google Cloud Monitoring metrics, read live through Google's Prometheus-compatible API: the query
 * engine's `GcpLiveMetrics` port. A connection with metrics on (its read-only account in place)
 * is a target: a project scope is its project, a folder or organization the active projects its
 * last inventory sync found. Each project is read with its connection's read-only account, one
 * call per metrics scope. What answered is returned, unless the read requires every project.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { EdgeCacheService } from "@maple/cache"
import { GcpConnectors, GcpResources, type GcpConnectorRow } from "@maple/db/tables"
import {
	GcpMetricDescriptor,
	GcpMonitoredResourceType,
	type GcpPromQlSeries,
} from "@maple/domain/gcp-live-metrics"
import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
import {
	GCP_LIVE_METRICS_NOT_AVAILABLE,
	GcpLiveQueryFailedError,
	GcpLiveQueryRejectedError,
	GcpLiveQueryUnavailableError,
} from "@maple/domain/http/gcp-live-query-errors"
import { GcpProjectId, type OrgId } from "@maple/domain/primitives"
import type { GcpLiveMetrics, GcpReadScope, QueryTenant } from "@maple/query-engine/runtime"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import {
	fetchMapleAccessToken,
	getMetricsScope,
	type GcpApiError,
	type GcpPromQlParams,
	type GcpReader,
	importServiceAccountKey,
	impersonateReader,
	listActiveMetricDescriptorsPage,
	listMonitoredResourceTypesPage,
	MetricsScope,
	promQlQuery,
} from "./gcp/api"
import { describeGcpApiError } from "./gcp/explain"

/** Google's tokens live 600 s. Three minutes to spare outlast the slowest fan-out. */
const TOKEN_REUSE_MS = 7 * 60_000
const CONCURRENCY = 4
/** The engine has no project picker: past this a query must filter on `project_id`. */
const MAX_PROJECTS = 20
/** Series Google returns across a query's projects. */
const MAX_SERIES = 500
/** Pages a listing reads: 10,000 metric descriptors a page, which a project rarely fills. */
const MAX_LIST_PAGES = 5
const HOUR_SECONDS = 3_600
/** Google's resource types change with its releases, not with the project. */
const DAY_SECONDS = 86_400
/** Above the default: a miss here costs a Google call, not a row lookup. */
const CACHE_READ_TIMEOUT_MS = 250
const API_ERROR = "@maple/api/integrations/GcpApiError"

const isProjectId = Schema.is(GcpProjectId)

type Connector = Pick<
	GcpConnectorRow,
	| "id"
	| "scopeType"
	| "scopeId"
	| "projectId"
	| "lastMetricsReceivedAt"
	| "lastResourcesError"
	| "resourcesSyncedAt"
>
type Port = GcpLiveMetrics<QueryTenant>
interface Target {
	readonly projectId: GcpProjectId
	readonly connector: Connector
}

const scopeName = (connector: Connector) => `${connector.scopeType}s/${connector.scopeId}`

/**
 * A connection or project that could not be read. `transient`: Google did not answer.
 * `refusal`: Google would not finish the query (422 `execution`). `setup`: anything a retry
 * does not fix (a missing role, API or billing account, projects not listed yet).
 */
interface Failure {
	readonly scope: string
	readonly message: string
	readonly cause: "transient" | "refusal" | "setup"
}

const causeOf = (error: GcpApiError): Failure["cause"] =>
	error.kind === "rate_limited" || error.kind === "upstream"
		? "transient"
		: error.kind === "invalid" && error.reason === "QUERY_EXECUTION"
			? "refusal"
			: "setup"

/** A `catchTag` handler that records a Google failure and goes on without the answer. */
const recordFailure =
	(failures: Array<Failure>, scope: string, connector: Connector) => (error: GcpApiError) => {
		failures.push({
			scope,
			message: describeGcpApiError(error, connector, "live"),
			cause: causeOf(error),
		})
		return Effect.succeed(undefined)
	}

/**
 * A read that failed. Worth a retry only when Google did not answer; a query Google would not
 * finish is the caller's to narrow; anything else (a missing role, API or billing account) is
 * setup that no retry fixes.
 */
const readFailed = (failures: ReadonlyArray<Failure>) => {
	const text = `Google Cloud could not be read. ${failures.map((failure) => `${failure.scope}: ${failure.message}`).join(" ")}`
	if (failures.every((failure) => failure.cause === "transient")) {
		return new GcpLiveQueryFailedError({
			message: text,
			failures: failures.map(({ scope, message }) => ({ scope, message })),
		})
	}
	if (failures.every((failure) => failure.cause !== "setup")) {
		return new GcpLiveQueryRejectedError({ message: text, reason: "invalid_query" })
	}
	return new GcpLiveQueryUnavailableError({ message: text })
}

/** Partial answers have no warnings channel: the failures go to the span and the log. */
const logFailures = (failures: ReadonlyArray<Failure>) => {
	const [first] = failures
	return first === undefined
		? Effect.void
		: Effect.annotateCurrentSpan({
				"maple.gcp.failed_projects": failures.length,
				"maple.gcp.failure": first.message,
			}).pipe(
				Effect.andThen(
					Effect.logWarning("gcp live read failed in part", {
						failures: failures.map(({ scope, message }) => ({ scope, message })),
					}),
				),
			)
}

const mapleSignInFailed = () =>
	new GcpLiveQueryFailedError({
		message:
			"Maple could not sign in to Google Cloud. Try again in a few minutes. If this repeats, write to support@maple.dev.",
		failures: [],
	})

/** A folder or organization not synced yet, or whose sync failed: nothing to read it by. */
const unlisted = (connector: Connector): Failure => ({
	scope: scopeName(connector),
	message:
		connector.lastResourcesError === null
			? "Maple has not listed this connection's projects yet. They appear after its first resource sync."
			: `Maple could not list this connection's projects: ${connector.lastResourcesError}`,
	cause: "setup",
})

/**
 * The targets a read covers: the projects it names when each is a target, else all of them, with
 * the connections whose projects are not known. A project reached only through another's
 * metrics scope is read through that one, and the query's `project_id` matcher keeps it alone.
 * Past `MAX_PROJECTS` a query must name its projects; discovery reads the first ones instead.
 */
const selectTargets = (
	all: { readonly targets: ReadonlyArray<Target>; readonly unlisted: ReadonlyArray<Failure> },
	scope: GcpReadScope,
): Effect.Effect<
	{ readonly targets: ReadonlyArray<Target>; readonly failures: ReadonlyArray<Failure> },
	GcpLiveQueryRejectedError
> => {
	const requested = scope.projects
	const known = new Set<string>(all.targets.map((target) => target.projectId))
	if (requested !== undefined && requested.every((projectId) => known.has(projectId))) {
		const named = all.targets.filter((target) => requested.includes(target.projectId))
		return Effect.succeed({ targets: named, failures: [] })
	}
	if (all.targets.length <= MAX_PROJECTS || scope.discovery) {
		return Effect.succeed({ targets: all.targets.slice(0, MAX_PROJECTS), failures: all.unlisted })
	}
	const outside = requested?.filter((projectId) => !known.has(projectId)) ?? []
	const examples = all.targets
		.slice(0, 5)
		.map((target) => target.projectId)
		.join(", ")
	return Effect.fail(
		new GcpLiveQueryRejectedError({
			message:
				outside.length > 0
					? `The project_id filter names ${outside.join(", ")}, which no connection reads as its own project (it is reached through a metrics scope), so Maple cannot narrow the read to it, and the connections reach ${all.targets.length} projects, more than the ${MAX_PROJECTS} one query reads. Filter on the projects whose metrics scopes hold it instead.`
					: `The Google Cloud connections reach ${all.targets.length} projects, and one query reads at most ${MAX_PROJECTS}. Filter on project_id to choose them, e.g. ${examples}.`,
			reason: "too_many_projects",
		}),
	)
}

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
			const dbExecute = makeDbExecute(
				database,
				"GcpLiveMetricsService",
				() =>
					new GcpLiveQueryFailedError({
						message:
							"Maple could not read its Google Cloud connections. Try again in a few minutes.",
						failures: [],
					}),
			)

			const signingKey = Option.match(env.MAPLE_GCP_SERVICE_ACCOUNT_KEY, {
				onNone: () =>
					Effect.fail(
						new GcpLiveQueryUnavailableError({ message: GCP_LIVE_METRICS_NOT_AVAILABLE }),
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

			/**
			 * Every project the org's metrics-on connections reach, each with the connection that reads
			 * it, by id, and the folders and organizations with no project listed.
			 */
			const targetsOf = Effect.fnUntraced(function* (orgId: OrgId) {
				const connectors = yield* dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select(
								"id",
								"scopeType",
								"scopeId",
								"projectId",
								"lastMetricsReceivedAt",
								"lastResourcesError",
								"resourcesSyncedAt",
							)
							.where(($) => [$.orgId.eq(orgId), $.appliedMetricsEnabled.eq(true)])
							.orderBy(($) => [
								[$.createdAt, "asc"],
								[$.id, "asc"],
							]),
					),
				)
				if (connectors.length === 0) {
					return yield* new GcpLiveQueryUnavailableError({
						message: "Connect Google Cloud with metrics on to query Google Cloud metrics.",
					})
				}
				const folders = connectors.filter((connector) => connector.scopeType !== "project")
				// A project pending deletion answers nothing but errors.
				const inventory =
					folders.length === 0
						? []
						: yield* dbExecute((db) =>
								db.run(
									PG.from(GcpResources)
										.select("connectorId", "projectId")
										.where(($) => [
											$.connectorId.in_(...folders.map((connector) => connector.id)),
											$.assetType.eq(GCP_PROJECT_ASSET_TYPE),
											PG.or($.state.isNull(), $.state.eq("ACTIVE")),
										]),
								),
							)
				// Overlapping connections read a project through the oldest.
				const targets = new Map<string, Target>()
				const notListed: Array<Failure> = []
				for (const connector of connectors) {
					const projectIds =
						connector.scopeType === "project"
							? [connector.projectId]
							: inventory
									.filter((row) => row.connectorId === connector.id)
									.map((row) => row.projectId)
					// A synced folder with no active project is just empty.
					const unsynced =
						connector.resourcesSyncedAt === null || connector.lastResourcesError !== null
					if (projectIds.length === 0 && unsynced) notListed.push(unlisted(connector))
					for (const projectId of projectIds) {
						if (isProjectId(projectId) && !targets.has(projectId))
							targets.set(projectId, { projectId, connector })
					}
				}
				return {
					targets: [...targets.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
					unlisted: notListed,
				}
			})

			/** Signs each connection in once, so one that cannot fails once, not once per project. */
			const signIn = Effect.fnUntraced(function* (
				key: Redacted.Redacted<string>,
				targets: ReadonlyArray<Target>,
				failures: Array<Failure>,
			) {
				const signedIn = new Map<Connector, GcpReader | undefined>()
				for (const connector of new Set(targets.map((target) => target.connector))) {
					signedIn.set(
						connector,
						yield* readerFor(key, connector).pipe(
							Effect.catchTag(
								API_ERROR,
								recordFailure(failures, scopeName(connector), connector),
							),
						),
					)
				}
				return targets.flatMap((target) => {
					const reader = signedIn.get(target.connector)
					return reader === undefined ? [] : [{ ...target, reader }]
				})
			})

			const runQuery = Effect.fnUntraced(function* (
				orgId: OrgId,
				options: GcpReadScope,
				params: GcpPromQlParams,
			) {
				const key = yield* signingKey
				const selected = yield* selectTargets(yield* targetsOf(orgId), options)
				yield* Effect.annotateCurrentSpan({ "maple.gcp.project_count": selected.targets.length })
				const failures: Array<Failure> = [...selected.failures]
				const signedIn = yield* signIn(key, selected.targets, failures)

				// A query on a project reads its whole metrics scope, so a target whose whole scope wider
				// ones already read is answered through them, not read again. Partly covered scopes are
				// read; the engine drops the series two scopes both return.
				const scoped = yield* Effect.forEach(
					signedIn,
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
								Effect.catchTag(
									API_ERROR,
									recordFailure(failures, `projects/${target.projectId}`, target.connector),
								),
							),
					{ concurrency: CONCURRENCY },
				)
				const covered = new Set<string>()
				const reads = scoped
					.filter((target) => target !== undefined)
					// Widest scopes first.
					.sort((a, b) => b.scope.monitored.length - a.scope.monitored.length)
					.filter((target) => {
						if (target.scope.monitored.every((number) => covered.has(number))) return false
						for (const number of target.scope.monitored) covered.add(number)
						return true
					})

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
							Effect.catchTag(
								API_ERROR,
								recordFailure(failures, `projects/${read.projectId}`, read.connector),
							),
						),
					{ concurrency: CONCURRENCY },
				)
				const answered = answers.filter((answer) => answer !== undefined)
				yield* logFailures(failures)
				if (failures.length > 0 && (options.requireComplete || answered.length === 0)) {
					return yield* readFailed(failures)
				}
				const series = answered.flatMap(({ read, series }) =>
					series.map((one): GcpPromQlSeries => ({
						// A scope of several projects names itself, not a project its series may not come from.
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

			/** Every page of a project's listing, at most `MAX_LIST_PAGES`. */
			const listAll = Effect.fnUntraced(function* <A>(
				listPage: (
					httpClient: HttpClient.HttpClient,
					reader: GcpReader,
					projectId: GcpProjectId,
					pageToken: string | undefined,
				) => Effect.Effect<
					{ readonly items: ReadonlyArray<A>; readonly nextPageToken?: string | undefined },
					GcpApiError
				>,
				reader: GcpReader,
				projectId: GcpProjectId,
			) {
				const items: Array<A> = []
				let pageToken: string | undefined
				for (let page = 0; page < MAX_LIST_PAGES; page++) {
					const body = yield* listPage(httpClient, reader, projectId, pageToken)
					items.push(...body.items)
					pageToken = body.nextPageToken
					if (pageToken === undefined) break
				}
				return items
			})

			return {
				queryRange: Effect.fn("GcpLiveMetricsService.queryRange")(function* (
					tenant: QueryTenant,
					request: Parameters<Port["queryRange"]>[1],
				) {
					return yield* runQuery(tenant.orgId, request, {
						query: request.query,
						start: request.startSeconds,
						end: request.endSeconds,
						step: request.stepSeconds,
					})
				}),
				queryInstant: Effect.fn("GcpLiveMetricsService.queryInstant")(function* (
					tenant: QueryTenant,
					request: Parameters<Port["queryInstant"]>[1],
				) {
					return yield* runQuery(tenant.orgId, request, {
						query: request.query,
						time: request.timeSeconds,
					})
				}),
				listMetrics: Effect.fn("GcpLiveMetricsService.listMetrics")(function* (
					tenant: QueryTenant,
					options: GcpReadScope,
				) {
					const key = yield* signingKey
					const selected = yield* selectTargets(yield* targetsOf(tenant.orgId), options)
					yield* Effect.annotateCurrentSpan({ "maple.gcp.project_count": selected.targets.length })
					const failures: Array<Failure> = [...selected.failures]
					const signedIn = yield* signIn(key, selected.targets, failures)
					const listed = yield* Effect.forEach(
						signedIn,
						(target) =>
							edgeCache
								.getOrCompute(
									{
										bucket: "gcp-metric-descriptors",
										key: `${tenant.orgId}:${target.projectId}`,
										ttlSeconds: HOUR_SECONDS,
										readTimeoutMs: CACHE_READ_TIMEOUT_MS,
										schema: Schema.Array(GcpMetricDescriptor),
									},
									listAll(listActiveMetricDescriptorsPage, target.reader, target.projectId),
								)
								.pipe(
									Effect.map(({ value }) => value),
									Effect.catchTag(
										API_ERROR,
										recordFailure(
											failures,
											`projects/${target.projectId}`,
											target.connector,
										),
									),
								),
						{ concurrency: CONCURRENCY },
					)
					const lists = listed.filter((list) => list !== undefined)
					yield* logFailures(failures)
					if (failures.length > 0 && (options.requireComplete || lists.length === 0)) {
						return yield* readFailed(failures)
					}
					return mergeDescriptors(lists)
				}),
				listResourceTypes: Effect.fn("GcpLiveMetricsService.listResourceTypes")(function* (
					tenant: QueryTenant,
					options: GcpReadScope,
				) {
					const key = yield* signingKey
					const selected = yield* selectTargets(yield* targetsOf(tenant.orgId), options)
					const failures: Array<Failure> = [...selected.failures]
					const signedIn = yield* signIn(key, selected.targets, failures)
					// The types are Google's, the same in every project: the first project that answers speaks.
					for (const target of signedIn) {
						const types = yield* edgeCache
							.getOrCompute(
								{
									bucket: "gcp-resource-types",
									key: `${tenant.orgId}:${target.projectId}`,
									ttlSeconds: DAY_SECONDS,
									readTimeoutMs: CACHE_READ_TIMEOUT_MS,
									schema: Schema.Array(GcpMonitoredResourceType),
								},
								listAll(listMonitoredResourceTypesPage, target.reader, target.projectId),
							)
							.pipe(
								Effect.map(({ value }) => value),
								Effect.catchTag(
									API_ERROR,
									recordFailure(failures, `projects/${target.projectId}`, target.connector),
								),
							)
						if (types !== undefined) return types
					}
					yield* logFailures(failures)
					return failures.length > 0 ? yield* readFailed(failures) : []
				}),
			} satisfies Port
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
