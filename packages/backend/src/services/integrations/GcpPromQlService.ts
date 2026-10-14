/**
 * Live PromQL over the Google Cloud projects an organization has connected, through Google's
 * Prometheus-compatible API. Every connection is a target, whatever its metrics switch: a project
 * scope is its project, a folder or organization the active projects Cloud Asset finds under it.
 * Each project is read with its connection's read-only account, one call per project, and what
 * fails is reported beside what answered.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { EdgeCacheService } from "@maple/cache"
import { GcpConnectors, type GcpConnectorRow } from "@maple/db/tables"
import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
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
	gcpPromQlTimeMs,
	GcpPromQlUnavailableError,
	IntegrationsNotConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
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
	type GcpApiError,
	type GcpPromQlParams,
	type GcpReader,
	importServiceAccountKey,
	impersonateReader,
	listPromQlMetricNames,
	promQlQuery,
	searchResourcesPage,
} from "./gcp/api"
import { describeGcpApiError } from "./gcp/explain"
import { mapGcpResource } from "./gcp/mapping"

/** Google's tokens live 600 s; one is reused until a minute before that. */
const TOKEN_REUSE_MS = 9 * 60_000
const CONCURRENCY = 4
/** Projects a folder or organization search reads, 500 a page. */
const MAX_PROJECT_PAGES = 4
const HOUR_SECONDS = 3_600
/** A window ending this close to now still gains points: its result is kept a minute, else ten. */
const FRESH_MS = 5 * 60_000
const DISTRIBUTION_SUFFIX = /_(bucket|count|sum)$/u

const isProjectId = Schema.is(GcpProjectId)

type Connector = Pick<GcpConnectorRow, "id" | "scopeType" | "scopeId" | "projectId" | "lastMetricsReceivedAt">

const scopeName = (connector: Connector) => `${connector.scopeType}s/${connector.scopeId}`

export type GcpPromQlError =
	| GcpPromQlUnavailableError
	| IntegrationsNotConnectedError
	| IntegrationsValidationError
	| GcpPromQlInvalidQueryError
	| GcpPromQlTooManyProjectsError
	| GcpPromQlFailedError
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
					const signer = yield* importServiceAccountKey(key)
					mapleToken = {
						token: yield* fetchMapleAccessToken(httpClient, signer, now),
						until: now + TOKEN_REUSE_MS,
					}
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
					const body = yield* searchResourcesPage(httpClient, reader, scope, pageToken, [
						GCP_PROJECT_ASSET_TYPE,
					])
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
							.select("id", "scopeType", "scopeId", "projectId", "lastMetricsReceivedAt")
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
				// One connection at a time, so a cold isolate signs in as Maple once.
				const listed = yield* Effect.forEach(connectors, (connector) =>
					connector.scopeType === "project"
						? Effect.succeed({
								connector,
								projects: isProjectId(connector.scopeId) ? [connector.scopeId] : [],
							})
						: edgeCache
								.getOrCompute(
									{
										bucket: "gcp-projects",
										key: `${orgId}:${connector.id}`,
										ttlSeconds: HOUR_SECONDS,
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
					if (unknown.length > 0) return yield* notReadable(unknown)
					selected = selected.filter(([projectId]) => requested.includes(projectId))
				} else if (selected.length > GCP_PROMQL_MAX_PROJECTS) {
					return yield* new GcpPromQlTooManyProjectsError({
						message: `The Google Cloud connections reach ${selected.length} projects, and one query reads at most ${GCP_PROMQL_MAX_PROJECTS}. Choose the projects to query.`,
						projects: selected.map(([projectId]) => projectId),
					})
				}
				const resultType = "time" in params ? "vector" : "matrix"
				if (selected.length === 0) {
					if (targets.failures.length > 0) return yield* nothingRead(targets.failures)
					return new GcpPromQlResult({ resultType, series: [], projects: [], failures: [] })
				}
				selected.sort(([a], [b]) => a.localeCompare(b))
				yield* Effect.annotateCurrentSpan({ "maple.gcp.projects": selected.length })

				const compute = Effect.gen(function* () {
					// Signed in one connection at a time, so a cold isolate signs in as Maple once. A
					// connection that cannot sign in fails once, not once per project.
					const readers = new Map<Connector, GcpReader>()
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
						if (reader !== undefined) readers.set(connector, reader)
					}
					const answers = yield* Effect.forEach(
						selected.flatMap(([projectId, connector]) => {
							const reader = readers.get(connector)
							return reader === undefined ? [] : [{ projectId, connector, reader }]
						}),
						({ projectId, connector, reader }) =>
							promQlQuery(httpClient, reader, projectId, params).pipe(
								Effect.map((series) => ({ projectId, series })),
								Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
									Effect.succeed({
										projectId,
										failure: failure(projectId, connector, error),
									}),
								),
							),
						{ concurrency: CONCURRENCY },
					)
					failures.push(
						...answers.flatMap((answer) => ("failure" in answer ? [answer.failure] : [])),
					)
					const answered = answers.flatMap((answer) => ("series" in answer ? [answer] : []))
					// Not cached: a fixed setup is read again on the next try.
					if (answered.length === 0) return yield* nothingRead([...targets.failures, ...failures])
					return new GcpPromQlResult({
						resultType,
						// Identical label sets from two projects stay apart.
						series: answered.flatMap(({ projectId, series }) =>
							series.map((one) => ({
								labels: { ...one.labels, project_id: one.labels.project_id ?? projectId },
								points: one.points,
							})),
						),
						projects: answered.map(({ projectId }) => projectId),
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
				const step = request.stepSeconds
				// Aligned to the step, so refreshes inside it share a cache entry.
				const start = Math.floor(gcpPromQlTimeMs(request.startTime) / 1000 / step) * step
				const end = Math.ceil(gcpPromQlTimeMs(request.endTime) / 1000 / step) * step
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
				if (project !== undefined && connector === undefined) return yield* notReadable([project])
				if (projectId === undefined || connector === undefined)
					return yield* nothingRead(targets.failures)
				return {
					projectId,
					reader: readerFor(key, connector),
					failed: (error: GcpApiError) => nothingRead([failure(projectId, connector, error)]),
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
							schema: Schema.Array(Schema.String),
						},
						target.reader.pipe(
							Effect.flatMap((reader) =>
								listPromQlMetricNames(httpClient, reader, target.projectId),
							),
						),
					)
					.pipe(Effect.mapError(target.failed))
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
						Effect.mapError(target.failed),
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
