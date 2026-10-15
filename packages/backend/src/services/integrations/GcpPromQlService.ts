/**
 * Live PromQL over the Google Cloud projects an organization has connected, through Google's
 * Prometheus-compatible API. A connection whose read-only account is in place is a target: a
 * project scope is its project, a folder or organization the active projects Cloud Asset finds
 * under it. Each project is read with its connection's read-only account, one call per metrics
 * scope, and what fails is reported beside what answered.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { EdgeCacheService } from "@maple/cache"
import { GcpConnectors, type GcpConnectorRow } from "@maple/db/tables"
import {
	GCP_PROMQL_MAX_PROJECTS,
	GcpMetricDescriptor,
	GcpMetricSearchResponse,
	GcpPromQlFailedError,
	type GcpPromQlFailure,
	type GcpPromQlInstantRequest,
	type GcpPromQlInvalidQueryError,
	type GcpPromQlRangeRequest,
	GcpPromQlResult,
	GcpPromQlTooManyProjectsError,
	GcpPromQlTooManySeriesError,
	GCP_PROMQL_MAX_SERIES,
	gcpPromQlRange,
	gcpPromQlTimeMs,
	GcpPromQlUnavailableError,
	IntegrationsNotConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
} from "@maple/domain/http"
import { GcpProjectId, type OrgId } from "@maple/domain/primitives"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import {
	fetchMapleAccessToken,
	getMetricDescriptor,
	getMetricsScope,
	type GcpApiError,
	type GcpPromQlParams,
	type GcpReader,
	importServiceAccountKey,
	impersonateReader,
	listPromQlMetricNames,
	promQlQuery,
	searchProjectsPage,
} from "./gcp/api"
import { describeGcpApiError } from "./gcp/explain"
import { mapGcpResource } from "./gcp/mapping"

/** Google's tokens live 600 s. Three minutes to spare outlast the slowest fan-out. */
const TOKEN_REUSE_MS = 7 * 60_000
const CONCURRENCY = 4
/** Projects a folder or organization search reads, 500 a page. */
const MAX_PROJECT_PAGES = 4
const HOUR_SECONDS = 3_600
/** A window ending this close to now still gains points: its result is kept a minute, else ten. */
const FRESH_MS = 5 * 60_000
/** Above the default: a miss here costs a Google fan-out, not a row lookup. */
const CACHE_READ_TIMEOUT_MS = 250
/** Why IAM Credentials refuses Maple's own project; impersonation does not go through the host. */
const MAPLE_SIDE_REASONS = new Set(["SERVICE_DISABLED", "BILLING_DISABLED", "USER_PROJECT_DENIED"])
const DISTRIBUTION_SUFFIX = /_(bucket|count|sum)$/u

const isProjectId = Schema.is(GcpProjectId)

type Connector = Pick<GcpConnectorRow, "id" | "scopeType" | "scopeId" | "projectId" | "lastMetricsReceivedAt">

const scopeName = (connector: Connector) => `${connector.scopeType}s/${connector.scopeId}`

/** A project's metrics scope: its number, and the numbers of the projects it reads, itself included. */
const MetricsScope = Schema.Struct({ number: Schema.String, monitored: Schema.Array(Schema.String) })

const NOT_SET_UP =
	"This connection's read-only account is not in place yet, so live queries can't read through it. Run the setup script again: it creates the account. If the script stops at an organization policy that restricts sharing to your domain, follow the setup guide's section on domain-restricted sharing."

export type GcpPromQlError =
	| GcpPromQlUnavailableError
	| IntegrationsNotConnectedError
	| IntegrationsValidationError
	| GcpPromQlInvalidQueryError
	| GcpPromQlTooManyProjectsError
	| GcpPromQlTooManySeriesError
	| GcpPromQlFailedError
	| IntegrationsUpstreamError
	| IntegrationsPersistenceError

export interface GcpPromQlServiceApi {
	readonly queryRange: (
		orgId: OrgId,
		request: GcpPromQlRangeRequest,
	) => Effect.Effect<GcpPromQlResult, GcpPromQlError>
	readonly queryInstant: (
		orgId: OrgId,
		request: GcpPromQlInstantRequest,
	) => Effect.Effect<GcpPromQlResult, GcpPromQlError>
	/** Metric names containing `search`, from one project's metric list. */
	readonly searchMetrics: (
		orgId: OrgId,
		request: {
			readonly search: string
			readonly limit?: number | undefined
			readonly project?: GcpProjectId | undefined
		},
	) => Effect.Effect<GcpMetricSearchResponse, GcpPromQlError>
	/** A metric type's descriptor. A distribution's `_bucket`, `_count` or `_sum` name finds it too. */
	readonly describeMetric: (
		orgId: OrgId,
		request: { readonly type: string; readonly project?: GcpProjectId | undefined },
	) => Effect.Effect<GcpMetricDescriptor, GcpPromQlError | IntegrationsNotFoundError>
}

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Google Cloud connector database error",
)

const notReadable = (projects: ReadonlyArray<GcpProjectId>) =>
	new IntegrationsValidationError({
		message: `Not among the projects this organization's Google Cloud connections can read: ${projects.join(", ")}`,
	})

const nothingRead = (failures: ReadonlyArray<GcpPromQlFailure>) =>
	new GcpPromQlFailedError({
		message:
			failures.length === 0
				? "The Google Cloud connections hold no project to read."
				: `Google Cloud could not be read. ${failures.map((failure) => `${failure.scope}: ${failure.message}`).join(" ")}`,
		failures,
	})

export class GcpPromQlService extends Context.Service<GcpPromQlService, GcpPromQlServiceApi>()(
	"@maple/api/services/GcpPromQlService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const edgeCache = yield* EdgeCacheService
			const dbExecute = makeDbExecute(database, "GcpPromQlService", toPersistenceError)

			const signingKey = Option.match(env.MAPLE_GCP_SERVICE_ACCOUNT_KEY, {
				onNone: () =>
					Effect.fail(
						new GcpPromQlUnavailableError({
							message:
								"Live Google Cloud queries are not available on this Maple deployment: it has no Google service account key (MAPLE_GCP_SERVICE_ACCOUNT_KEY).",
						}),
					),
				onSome: Effect.succeed,
			})

			// Tokens are kept for the isolate's lifetime. Only settled values are kept: a pending
			// sign-in shared across requests would resume in another request's I/O context.
			let mapleToken: { readonly token: Redacted.Redacted<string>; readonly until: number } | undefined
			const readers = new Map<Connector["id"], { readonly reader: GcpReader; readonly until: number }>()

			const readerFor = Effect.fnUntraced(function* (
				key: Redacted.Redacted<string>,
				connector: Connector,
			) {
				const now = yield* Clock.currentTimeMillis
				const cached = readers.get(connector.id)
				if (cached !== undefined && cached.until > now) return cached.reader
				if (mapleToken === undefined || mapleToken.until <= now) {
					// Maple's own sign-in: its failure is no connection's, and its cause is not the customer's.
					const token = yield* importServiceAccountKey(key).pipe(
						Effect.flatMap((signer) => fetchMapleAccessToken(httpClient, signer, now)),
						Effect.tapError((error) =>
							Effect.logError("gcp sign-in as Maple failed", { error: error.message }),
						),
						Effect.mapError(
							() =>
								new IntegrationsUpstreamError({
									message: "Maple could not sign in to Google Cloud",
								}),
						),
					)
					mapleToken = { token, until: now + TOKEN_REUSE_MS }
				}
				const reader = yield* impersonateReader(httpClient, mapleToken.token, connector).pipe(
					// Google's fault, or Maple's own project's (API off, no billing): not the connection's. A denial
					// otherwise (`IAM_PERMISSION_DENIED`) is a grant the connection lacks.
					Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
						Effect.gen(function* () {
							if (error.kind !== "upstream" && !MAPLE_SIDE_REASONS.has(error.reason ?? ""))
								return yield* error
							yield* Effect.logError("gcp impersonation failed on Maple's side", {
								error: error.message,
							})
							return yield* new IntegrationsUpstreamError({
								message: "Maple could not sign in to Google Cloud",
							})
						}),
					),
				)
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
			 * Every project the org's connections reach, each with the connection that reads it, and
			 * the connections whose projects could not be listed.
			 */
			const targetsOf = Effect.fnUntraced(function* (orgId: OrgId, key: Redacted.Redacted<string>) {
				const connectors = yield* dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select(
								"id",
								"scopeType",
								"scopeId",
								"projectId",
								"lastMetricsReceivedAt",
								"appliedMetricsEnabled",
							)
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(($) => [
								[$.createdAt, "asc"],
								[$.id, "asc"],
							]),
					),
				)
				if (connectors.length === 0) {
					return yield* new IntegrationsNotConnectedError({
						message:
							"No Google Cloud connection yet. Connect a project, folder or organization first.",
					})
				}
				// The setup script reported the read-only account: the others are left out, and only
				// when none has one is that the answer.
				const ready = connectors.filter((connector) => connector.appliedMetricsEnabled === true)
				if (ready.length === 0) {
					return yield* nothingRead(
						connectors.map((connector) => ({ scope: scopeName(connector), message: NOT_SET_UP })),
					)
				}
				// One connection at a time, so a cold isolate signs in as Maple once.
				const listed = yield* Effect.forEach(ready, (connector) =>
					connector.scopeType === "project"
						? Effect.succeed({
								connector,
								// A project scope is its own host.
								projects: [connector.projectId],
							})
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
									Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
										Effect.succeed({
											connector,
											projects: [],
											failure: {
												scope: scopeName(connector),
												message: describeGcpApiError(error, connector, true),
											},
										}),
									),
								),
				)
				// Overlapping connections read a project through the oldest.
				const projects = new Map<GcpProjectId, Connector>()
				for (const { connector, projects: ids } of listed) {
					for (const id of ids) if (!projects.has(id)) projects.set(id, connector)
				}
				return {
					projects,
					failures: listed.flatMap((entry) => ("failure" in entry ? [entry.failure] : [])),
				}
			})

			const failure = (
				projectId: GcpProjectId,
				connector: Connector,
				error: GcpApiError,
			): GcpPromQlFailure => ({
				scope: `projects/${projectId}`,
				message: describeGcpApiError(error, connector, true),
			})

			const runQuery = Effect.fnUntraced(function* (
				orgId: OrgId,
				requested: ReadonlyArray<GcpProjectId> | undefined,
				params: GcpPromQlParams,
				endMs: number,
			) {
				const key = yield* signingKey
				const targets = yield* targetsOf(orgId, key)
				let selected = [...targets.projects.entries()]
				if (requested !== undefined) {
					const unknown = requested.filter((projectId) => !targets.projects.has(projectId))
					if (unknown.length > 0) {
						// A connection whose projects could not be listed may hold them.
						if (targets.failures.length > 0) return yield* nothingRead(targets.failures)
						return yield* notReadable(unknown)
					}
					selected = selected.filter(([projectId]) => requested.includes(projectId))
				} else if (selected.length > GCP_PROMQL_MAX_PROJECTS) {
					return yield* new GcpPromQlTooManyProjectsError({
						message: `The Google Cloud connections reach ${selected.length} projects, and one query reads at most ${GCP_PROMQL_MAX_PROJECTS}. Choose the projects to query.`,
						projects: selected.map(([projectId]) => projectId),
					})
				}
				if (selected.length === 0) {
					if (targets.failures.length > 0) return yield* nothingRead(targets.failures)
					return new GcpPromQlResult({
						resultType: "time" in params ? "vector" : "matrix",
						series: [],
						projects: [],
						failures: [],
					})
				}
				selected.sort(([a], [b]) => a.localeCompare(b))
				yield* Effect.annotateCurrentSpan({ "maple.gcp.projects": selected.length })

				const compute = Effect.gen(function* () {
					// Signed in one connection at a time, so a cold isolate signs in as Maple once. A
					// connection that cannot sign in fails once, not once per project.
					const signedIn = new Map<Connector, GcpReader>()
					const failures: Array<GcpPromQlFailure> = []
					for (const connector of new Set(selected.map(([, connector]) => connector))) {
						const reader = yield* readerFor(key, connector).pipe(
							Effect.catchTag("@maple/api/integrations/GcpApiError", (error) => {
								failures.push({
									scope: scopeName(connector),
									message: describeGcpApiError(error, connector, true),
								})
								return Effect.succeed(undefined)
							}),
						)
						if (reader !== undefined) signedIn.set(connector, reader)
					}
					// A query on a project reads its whole metrics scope, so a target that another read
					// target's scope holds is answered through that one, not read twice.
					const scoped = yield* Effect.forEach(
						selected.flatMap(([projectId, connector]) => {
							const reader = signedIn.get(connector)
							return reader === undefined ? [] : [{ projectId, connector, reader }]
						}),
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
									Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
										Effect.succeed({
											...target,
											failure: failure(target.projectId, target.connector, error),
										}),
									),
								),
						{ concurrency: CONCURRENCY },
					)
					failures.push(
						...scoped.flatMap((target) => ("failure" in target ? [target.failure] : [])),
					)
					const withScope = scoped.flatMap((target) => ("scope" in target ? [target] : []))
					const covered = new Set<string>()
					const reads: typeof withScope = []
					// Widest scopes first.
					for (const target of [...withScope].sort(
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
								Effect.flatMap((answer) =>
									Effect.gen(function* () {
										seriesCount += answer.series.length
										if (seriesCount > GCP_PROMQL_MAX_SERIES) {
											return yield* new GcpPromQlTooManySeriesError({
												message: `The query returned more than ${GCP_PROMQL_MAX_SERIES} series across its projects. Aggregate them with sum by (…) or avg by (…), or narrow the selector.`,
											})
										}
										return { read, answer }
									}),
								),
								Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
									Effect.succeed({
										read,
										failure: failure(read.projectId, read.connector, error),
									}),
								),
							),
						{ concurrency: CONCURRENCY },
					)
					failures.push(
						...answers.flatMap((answer) => ("failure" in answer ? [answer.failure] : [])),
					)
					const answered = answers.flatMap((answer) => ("answer" in answer ? [answer] : []))
					const [first] = answered
					// Not cached: a fixed setup is read again on the next try.
					if (first === undefined) return yield* nothingRead([...targets.failures, ...failures])
					return new GcpPromQlResult({
						resultType: first.answer.resultType,
						series: answered.flatMap(({ read, answer }) =>
							answer.series.map((one) => ({
								// Identical label sets from two projects stay apart. A scope of several
								// projects names itself, not a project its series may not come from.
								labels:
									one.labels.project_id === undefined
										? {
												...one.labels,
												[read.scope.monitored.length > 1
													? "metrics_scope"
													: "project_id"]: read.projectId,
											}
										: one.labels,
								points: one.points,
							})),
						),
						// A target answers through the read whose scope holds it.
						projects: withScope
							.filter((target) =>
								answered.some(
									({ read }) =>
										read === target || read.scope.monitored.includes(target.scope.number),
								),
							)
							.map((target) => target.projectId),
						failures,
					})
				})
				const now = yield* Clock.currentTimeMillis
				const { value } = yield* edgeCache.getOrCompute(
					{
						bucket: "gcp-promql",
						key: JSON.stringify([orgId, selected.map(([projectId]) => projectId), params]),
						ttlSeconds: (result) =>
							result.failures.length > 0 || endMs > now - FRESH_MS ? 60 : 600,
						schema: GcpPromQlResult,
						readTimeoutMs: CACHE_READ_TIMEOUT_MS,
					},
					compute,
				)
				return targets.failures.length === 0
					? value
					: new GcpPromQlResult({ ...value, failures: [...targets.failures, ...value.failures] })
			})

			const queryRange = Effect.fn("GcpPromQlService.queryRange")(function* (
				orgId: OrgId,
				request: GcpPromQlRangeRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				// Aligned to the step, so refreshes inside it share a cache entry.
				const { start, end, step } = gcpPromQlRange(request)
				return yield* runQuery(
					orgId,
					request.projects,
					{ query: request.query, start, end, step },
					end * 1000,
				)
			})

			const queryInstant = Effect.fn("GcpPromQlService.queryInstant")(function* (
				orgId: OrgId,
				request: GcpPromQlInstantRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const time = Math.floor(gcpPromQlTimeMs(request.time) / 60_000) * 60
				return yield* runQuery(orgId, request.projects, { query: request.query, time }, time * 1000)
			})

			/** One project to read discovery data from: the one named, or the first. */
			const discoveryProject = Effect.fnUntraced(function* (
				orgId: OrgId,
				project: GcpProjectId | undefined,
			) {
				const key = yield* signingKey
				const targets = yield* targetsOf(orgId, key)
				const projectId = project ?? targets.projects.keys().next().value
				const connector = projectId === undefined ? undefined : targets.projects.get(projectId)
				if (project !== undefined && connector === undefined) {
					if (targets.failures.length > 0) return yield* nothingRead(targets.failures)
					return yield* notReadable([project])
				}
				if (projectId === undefined || connector === undefined)
					return yield* nothingRead(targets.failures)
				return {
					projectId,
					reader: readerFor(key, connector),
					failed: (error: GcpApiError) =>
						Effect.fail(nothingRead([failure(projectId, connector, error)])),
				}
			})

			const searchMetrics = Effect.fn("GcpPromQlService.searchMetrics")(function* (
				orgId: OrgId,
				request: Parameters<GcpPromQlServiceApi["searchMetrics"]>[1],
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const target = yield* discoveryProject(orgId, request.project)
				const { value: names } = yield* edgeCache
					.getOrCompute(
						{
							bucket: "gcp-metric-names",
							key: `${orgId}:${target.projectId}`,
							ttlSeconds: HOUR_SECONDS,
							readTimeoutMs: CACHE_READ_TIMEOUT_MS,
							schema: Schema.Array(Schema.String),
						},
						target.reader.pipe(
							Effect.flatMap((reader) =>
								listPromQlMetricNames(httpClient, reader, target.projectId),
							),
						),
					)
					.pipe(Effect.catchTag("@maple/api/integrations/GcpApiError", target.failed))
				const search = request.search.toLowerCase()
				return new GcpMetricSearchResponse({
					projectId: target.projectId,
					metrics: names
						.filter((name) => name.toLowerCase().includes(search))
						.sort()
						.slice(0, request.limit ?? 50),
				})
			})

			const describeMetric = Effect.fn("GcpPromQlService.describeMetric")(function* (
				orgId: OrgId,
				request: Parameters<GcpPromQlServiceApi["describeMetric"]>[1],
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const target = yield* discoveryProject(orgId, request.project)
				const find = (type: string) =>
					target.reader.pipe(
						Effect.flatMap((reader) =>
							getMetricDescriptor(httpClient, reader, target.projectId, type),
						),
						Effect.catchTag("@maple/api/integrations/GcpApiError", target.failed),
					)
				const descriptor =
					(yield* find(request.type)) ??
					(DISTRIBUTION_SUFFIX.test(request.type)
						? yield* find(request.type.replace(DISTRIBUTION_SUFFIX, ""))
						: undefined)
				if (descriptor === undefined) {
					return yield* new IntegrationsNotFoundError({
						message: `Project ${target.projectId} has no metric type ${request.type}.`,
					})
				}
				return new GcpMetricDescriptor({
					type: descriptor.type,
					metricKind: descriptor.metricKind ?? "",
					valueType: descriptor.valueType ?? "",
					unit: descriptor.unit ?? "",
					description: descriptor.description ?? "",
					monitoredResourceTypes: descriptor.monitoredResourceTypes ?? [],
					labels: (descriptor.labels ?? []).map((label) => ({
						key: label.key,
						description: label.description ?? "",
					})),
				})
			})

			return { queryRange, queryInstant, searchMetrics, describeMetric } satisfies GcpPromQlServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
