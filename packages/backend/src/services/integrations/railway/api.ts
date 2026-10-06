/**
 * Railway API access through `@distilled.cloud/railway` (the Effect-native Railway GraphQL SDK):
 * token workspace discovery, project listing and the `metrics` query. The SDK's typed errors are
 * folded into one {@link RailwayApiError} whose `kind` drives the poller's back-off.
 */
import { Query } from "@distilled.cloud/core/query"
import {
	CredentialsFromToken,
	GqlTransport,
	GraphQLFailure,
	GraphQLLive,
	GraphQLPaginationError,
	GraphQLTransportError,
	Railway,
	type QueryError,
	type RailwayGlobalError,
} from "@distilled.cloud/railway"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"

const REQUEST_TIMEOUT = Duration.seconds(30)

export class RailwayApiError extends Schema.TaggedError<RailwayApiError>()(
	"@maple/api/integrations/RailwayApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "rate_limited", "upstream"]),
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
	},
) {}

/** Railway reports a bad token as an untyped "Not Authorized" error on some roots. */
const isAuthMessage = (message: string) =>
	/not authorized|unauthorized|unauthenticated|invalid token/i.test(message)

const AUTH_TAGS: ReadonlySet<string> = new Set(["RailwayForbidden", "RailwayUnauthenticated"])

type SdkError = QueryError<RailwayGlobalError> | GraphQLPaginationError

const toApiError = (error: SdkError): RailwayApiError => {
	const issues = error instanceof GraphQLFailure ? error.errors : [error]
	const status = error instanceof GraphQLTransportError ? error.status : undefined
	const retryAfter =
		error instanceof GraphQLFailure || error instanceof GraphQLPaginationError
			? undefined
			: error.retryAfter
	const retry = retryAfter === undefined ? undefined : { retryAfterSeconds: retryAfter }
	if (status === 429 || issues.some((issue) => issue._tag === "RailwayRateLimited")) {
		return new RailwayApiError({
			message: "Railway API rate limit reached",
			kind: "rate_limited",
			...retry,
		})
	}
	if (
		status === 401 ||
		status === 403 ||
		issues.some((issue) => AUTH_TAGS.has(issue._tag) || isAuthMessage(issue.message))
	) {
		return new RailwayApiError({ message: "Railway rejected the API token", kind: "unauthorized" })
	}
	return new RailwayApiError({
		message: `Railway API error: ${error.message.slice(0, 300)}`,
		kind: "upstream",
	})
}

/** Run one SDK query with the given token over the caller's HttpClient. */
const run = <A>(
	httpClient: HttpClient.HttpClient,
	token: string,
	effect: Effect.Effect<A, SdkError, GqlTransport>,
) =>
	effect.pipe(
		Effect.mapError(toApiError),
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () =>
				Effect.fail(
					new RailwayApiError({ message: "Railway API request timed out", kind: "upstream" }),
				),
		}),
		// The token is per org, so this cannot be hoisted into the static service graph;
		// the layer closes the distilled SDK query over it.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(Layer.mergeAll(GraphQLLive, CredentialsFromToken({ token, tokenKind: "account" }))),
		Effect.provideService(HttpClient.HttpClient, httpClient),
		Effect.annotateSpans("peer.service", "railway"),
	)

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const tokenWorkspaces = Query.fn(() =>
	Railway.apiToken().workspaces.pipe(
		Query.map((workspace) => ({ id: workspace.id, name: workspace.name })),
	),
)

/**
 * Nested connections read one page; following each project's cursor would cost a request per
 * project per discovery. A full page is reported as truncated so reconciliation keeps the rest.
 */
const NESTED_PAGE_SIZE = 100

/** Every project in the workspace, following the connection cursor page by page. */
const workspaceProjects = (workspaceId: string) =>
	Query.items(
		Railway.projects({ workspaceId, first: 50 }).pipe(
			Query.map((project) => ({
				id: project.id,
				name: project.name,
				environments: project.environments({ first: NESTED_PAGE_SIZE }).pipe(
					Query.map((environment) => ({
						id: environment.id,
						name: environment.name,
						isEphemeral: environment.isEphemeral,
					})),
				),
				services: project
					.services({ first: NESTED_PAGE_SIZE })
					.pipe(Query.map((service) => ({ id: service.id, name: service.name }))),
			})),
		),
	).pipe(Stream.runCollect)

export interface RailwayDiscoveredEnvironment {
	readonly projectId: string
	readonly projectName: string
	readonly environmentId: string
	readonly environmentName: string
	/** Railway service id → name. Services are project-wide; every environment carries the set. */
	readonly services: Readonly<Record<string, string>>
}

export interface RailwayDiscovery {
	readonly workspaceNames: ReadonlyArray<string>
	readonly environments: ReadonlyArray<RailwayDiscoveredEnvironment>
	/** Projects whose environment list filled a page and may be incomplete. */
	readonly truncatedProjectIds: ReadonlyArray<string>
}

/**
 * List the projects and non-ephemeral environments of every workspace the token can reach
 * (`apiToken` answers for account and workspace tokens alike). PR environments are skipped:
 * each costs a `metrics` call per tick against a small per-token rate limit.
 */
export const discover = (httpClient: HttpClient.HttpClient, token: string) =>
	Effect.gen(function* () {
		const workspaces = yield* run(httpClient, token, tokenWorkspaces())
		const pages = yield* Effect.forEach(
			workspaces,
			(workspace) => run(httpClient, token, workspaceProjects(workspace.id)),
			{ concurrency: 2 },
		)
		const environments: Array<RailwayDiscoveredEnvironment> = []
		const truncatedProjectIds: Array<string> = []
		const seen = new Set<string>()
		for (const project of pages.flat()) {
			if (project.environments.length >= NESTED_PAGE_SIZE) truncatedProjectIds.push(project.id)
			const services = Object.fromEntries(
				project.services.map((service) => [service.id, service.name] as const),
			)
			for (const environment of project.environments) {
				if (environment.isEphemeral === true || seen.has(environment.id)) continue
				seen.add(environment.id)
				environments.push({
					projectId: project.id,
					projectName: project.name,
					environmentId: environment.id,
					environmentName: environment.name,
					services,
				})
			}
		}
		return {
			workspaceNames: workspaces.map((workspace) => workspace.name).sort(),
			environments,
			truncatedProjectIds,
		} satisfies RailwayDiscovery
	}).pipe(Effect.withSpan("RailwayApi.discover"))

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const RAILWAY_MEASUREMENTS = [
	"CPU_USAGE",
	"CPU_LIMIT",
	"MEMORY_USAGE_GB",
	"MEMORY_LIMIT_GB",
	"NETWORK_RX_GB",
	"NETWORK_TX_GB",
	"DISK_USAGE_GB",
	"EPHEMERAL_DISK_USAGE_GB",
] as const

export type RailwayMeasurement = (typeof RAILWAY_MEASUREMENTS)[number]

export interface RailwayMetricsResult {
	readonly measurement: string
	readonly tags: {
		readonly serviceId?: string | null
		readonly deploymentInstanceId?: string | null
		readonly region?: string | null
	}
	readonly values: ReadonlyArray<{ readonly ts: number; readonly value: number }>
}

export interface RailwayMetricsWindow {
	readonly environmentId: string
	readonly startMs: number
	readonly endMs: number
	readonly sampleRateSeconds: number
}

const environmentMetrics = Query.fn((window: RailwayMetricsWindow) =>
	Railway.metrics({
		environmentId: window.environmentId,
		startDate: new Date(window.startMs).toISOString(),
		endDate: new Date(window.endMs).toISOString(),
		sampleRateSeconds: window.sampleRateSeconds,
		averagingWindowSeconds: window.sampleRateSeconds,
		groupBy: ["SERVICE_ID", "DEPLOYMENT_INSTANCE_ID"],
		measurements: RAILWAY_MEASUREMENTS,
	}).pipe(
		Query.map((result) => ({
			measurement: result.measurement,
			tags: {
				serviceId: result.tags.serviceId,
				deploymentInstanceId: result.tags.deploymentInstanceId,
				region: result.tags.region,
			},
			values: result.values.pipe(Query.map((point) => ({ ts: point.ts, value: point.value }))),
		})),
	),
)

/** One call for every service and replica in an environment. */
export const fetchEnvironmentMetrics = (
	httpClient: HttpClient.HttpClient,
	token: string,
	window: RailwayMetricsWindow,
): Effect.Effect<ReadonlyArray<RailwayMetricsResult>, RailwayApiError> =>
	run(httpClient, token, environmentMetrics(window)).pipe(
		Effect.withSpan("RailwayApi.fetchEnvironmentMetrics", {
			attributes: { "railway.environment.id": window.environmentId },
		}),
	)
