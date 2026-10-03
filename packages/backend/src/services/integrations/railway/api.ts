/**
 * Minimal client for Railway's public GraphQL API (backboard.railway.com/graphql/v2): project
 * discovery and the `metrics` query. Bearer auth only, which covers account and workspace tokens.
 */
import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2"

const REQUEST_TIMEOUT = Duration.seconds(20)

export class RailwayApiError extends Schema.TaggedError<RailwayApiError>()(
	"@maple/api/integrations/RailwayApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "rate_limited", "upstream", "invalid_response"]),
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
	},
) {}

const GraphqlError = Schema.Struct({ message: Schema.String })

const GraphqlEnvelope = Schema.Struct({
	data: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	errors: Schema.optionalKey(Schema.NullOr(Schema.Array(GraphqlError))),
})

const decodeEnvelope = Schema.decodeUnknownEffect(GraphqlEnvelope)

const isAuthMessage = (message: string) =>
	/not authorized|unauthorized|invalid token|forbidden/i.test(message)

const parseRetryAfter = (raw: string | undefined): number | undefined => {
	if (raw === undefined) return undefined
	const seconds = Number(raw)
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** POST one GraphQL document and decode `data` with `schema`. */
const graphql = <A>(
	httpClient: HttpClient.HttpClient,
	token: string,
	query: string,
	variables: Record<string, unknown>,
	schema: Schema.Decoder<A>,
) =>
	Effect.gen(function* () {
		const request = HttpClientRequest.post(RAILWAY_GRAPHQL_URL, {
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		}).pipe(HttpClientRequest.bodyJsonUnsafe({ query, variables }))
		const response = yield* httpClient.execute(request).pipe(
			Effect.annotateSpans("peer.service", "railway"),
			Effect.timeoutOrElse({
				duration: REQUEST_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new RailwayApiError({ message: "Railway API request timed out", kind: "upstream" }),
					),
			}),
			Effect.mapError((error) =>
				error instanceof RailwayApiError
					? error
					: new RailwayApiError({
							message: `Railway API request failed: ${error.message}`,
							kind: "upstream",
						}),
			),
		)
		if (response.status === 429) {
			const retryAfterSeconds = parseRetryAfter(response.headers["retry-after"])
			return yield* new RailwayApiError({
				message: "Railway API rate limit reached",
				kind: "rate_limited",
				...(retryAfterSeconds === undefined ? undefined : { retryAfterSeconds }),
			})
		}
		if (response.status === 401 || response.status === 403) {
			return yield* new RailwayApiError({
				message: "Railway rejected the API token",
				kind: "unauthorized",
			})
		}
		const body = yield* response.json.pipe(
			Effect.mapError(
				() =>
					new RailwayApiError({
						message: `Railway API returned a non-JSON body (HTTP ${response.status})`,
						kind: response.status >= 500 ? "upstream" : "invalid_response",
					}),
			),
		)
		const envelope = yield* decodeEnvelope(body).pipe(
			Effect.mapError(
				() =>
					new RailwayApiError({
						message: `Railway API returned an unexpected body (HTTP ${response.status})`,
						kind: "invalid_response",
					}),
			),
		)
		const errors = envelope.errors ?? []
		if (errors.length > 0) {
			const message = errors
				.map((error) => error.message)
				.join("; ")
				.slice(0, 300)
			return yield* new RailwayApiError({
				message: `Railway API error: ${message}`,
				kind: errors.some((error) => isAuthMessage(error.message)) ? "unauthorized" : "upstream",
			})
		}
		if (response.status >= 300) {
			return yield* new RailwayApiError({
				message: `Railway API returned HTTP ${response.status}`,
				kind: "upstream",
			})
		}
		return yield* Schema.decodeUnknownEffect(schema)(envelope.data).pipe(
			Effect.mapError(
				(error) =>
					new RailwayApiError({
						message: `Railway API response did not match the expected shape: ${error.message.slice(0, 200)}`,
						kind: "invalid_response",
					}),
			),
		)
	}).pipe(Effect.withSpan("RailwayApi.graphql"))

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const Edges = <S extends Schema.Top>(node: S) =>
	Schema.Struct({ edges: Schema.Array(Schema.Struct({ node })) })

const ProjectNode = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	workspace: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String }))),
	environments: Edges(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			isEphemeral: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		}),
	),
	services: Edges(Schema.Struct({ id: Schema.String, name: Schema.String })),
})

const ProjectsData = Schema.Struct({ projects: Edges(ProjectNode) })

const MeData = Schema.Struct({
	me: Schema.Struct({
		workspaces: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
	}),
})

const ME_QUERY = `query { me { workspaces { id name } } }`

const PROJECTS_QUERY = `query ($workspaceId: String) {
  projects(workspaceId: $workspaceId, first: 100) {
    edges { node {
      id name workspace { id name }
      environments { edges { node { id name isEphemeral } } }
      services { edges { node { id name } } }
    } }
  }
}`

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
}

/**
 * List the token's projects and their non-ephemeral environments. Account tokens enumerate
 * workspaces via `me`; workspace tokens cannot call `me`, so they fall back to a bare `projects`.
 * PR environments are skipped: each costs a `metrics` call per tick against a small rate limit.
 */
export const discover = (httpClient: HttpClient.HttpClient, token: string) =>
	Effect.gen(function* () {
		const me = yield* Effect.option(graphql(httpClient, token, ME_QUERY, {}, MeData))
		const workspaceIds = Option.match(me, {
			onNone: (): ReadonlyArray<string | null> => [null],
			onSome: (data) => data.me.workspaces.map((workspace) => workspace.id),
		})
		const pages = yield* Effect.forEach(
			workspaceIds,
			(workspaceId) => graphql(httpClient, token, PROJECTS_QUERY, { workspaceId }, ProjectsData),
			{ concurrency: 2 },
		)
		const workspaceNames = new Set<string>()
		const environments: Array<RailwayDiscoveredEnvironment> = []
		const seen = new Set<string>()
		for (const page of pages) {
			for (const { node: project } of page.projects.edges) {
				if (project.workspace?.name) workspaceNames.add(project.workspace.name)
				const services = Object.fromEntries(
					project.services.edges.map(({ node }) => [node.id, node.name] as const),
				)
				for (const { node: environment } of project.environments.edges) {
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
		}
		return { workspaceNames: [...workspaceNames].sort(), environments } satisfies RailwayDiscovery
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

const MetricsResult = Schema.Struct({
	measurement: Schema.String,
	tags: Schema.Struct({
		serviceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		deploymentInstanceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		region: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
	values: Schema.Array(Schema.Struct({ ts: Schema.Number, value: Schema.Number })),
})
export type RailwayMetricsResult = typeof MetricsResult.Type

const MetricsData = Schema.Struct({ metrics: Schema.Array(MetricsResult) })

const METRICS_QUERY = `query ($environmentId: String!, $startDate: DateTime!, $endDate: DateTime!, $sampleRateSeconds: Int!) {
  metrics(
    environmentId: $environmentId
    startDate: $startDate
    endDate: $endDate
    sampleRateSeconds: $sampleRateSeconds
    averagingWindowSeconds: $sampleRateSeconds
    groupBy: [SERVICE_ID, DEPLOYMENT_INSTANCE_ID]
    measurements: [${RAILWAY_MEASUREMENTS.join(", ")}]
  ) {
    measurement
    tags { serviceId deploymentInstanceId region }
    values { ts value }
  }
}`

export interface RailwayMetricsWindow {
	readonly environmentId: string
	readonly startMs: number
	readonly endMs: number
	readonly sampleRateSeconds: number
}

/** One call for every service and replica in an environment. */
export const fetchEnvironmentMetrics = (
	httpClient: HttpClient.HttpClient,
	token: string,
	window: RailwayMetricsWindow,
) =>
	graphql(
		httpClient,
		token,
		METRICS_QUERY,
		{
			environmentId: window.environmentId,
			startDate: new Date(window.startMs).toISOString(),
			endDate: new Date(window.endMs).toISOString(),
			sampleRateSeconds: window.sampleRateSeconds,
		},
		MetricsData,
	).pipe(
		Effect.map((data) => data.metrics),
		Effect.withSpan("RailwayApi.fetchEnvironmentMetrics", {
			attributes: { "railway.environment.id": window.environmentId },
		}),
	)
