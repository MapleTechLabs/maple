/**
 * Railway's GraphQL API on the vendor HTTP kit: token workspace discovery, project listing and
 * the `metrics` query. Every operation here is a read-only query, so each opts in to the kit's
 * transient retry. Failures fold into one {@link RailwayApiError} whose `kind` drives the poller.
 */
import { Array as Arr, Duration, Effect, Option, Order, Record as Rec, Schema, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import { RailwayApiError } from "./errors"

export { RailwayApiError }
import * as VendorHttp from "../vendor-http"
import { VENDOR_TRANSIENT_RETRY } from "../vendor-retry"

const BASE_URL = "https://backboard.railway.com"
const REQUEST_TIMEOUT = Duration.seconds(30)

const GraphqlIssue = Schema.Struct({
	message: Schema.String,
	extensions: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ code: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
})
type GraphqlIssue = typeof GraphqlIssue.Type

const Envelope = Schema.Struct({
	data: Schema.optionalKey(Schema.Unknown),
	errors: Schema.optionalKey(Schema.NullOr(Schema.Array(GraphqlIssue))),
})
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))

const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(["RATE_LIMITED", "TOO_MANY_REQUESTS"])
const AUTH_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHENTICATED", "UNAUTHORIZED"])

/** Railway reports a bad token as an untyped "Not Authorized" error on some roots. */
const isAuthMessage = (message: string) =>
	/not authorized|unauthorized|unauthenticated|invalid token/i.test(message)

const codeOf = (issue: GraphqlIssue) => issue.extensions?.code ?? ""

/** The kind a list of GraphQL errors means, whatever the HTTP status they came with. */
const issuesKind = (issues: ReadonlyArray<GraphqlIssue>): VendorHttp.VendorFailureKind | undefined =>
	Arr.some(issues, (issue) => RATE_LIMIT_CODES.has(codeOf(issue)) || /too quickly/i.test(issue.message))
		? "rate_limited"
		: Arr.some(issues, (issue) => AUTH_CODES.has(codeOf(issue)) || isAuthMessage(issue.message))
			? "unauthorized"
			: undefined

const issuesMessage = (issues: ReadonlyArray<GraphqlIssue>) =>
	Arr.join(
		Arr.map(issues, (issue) => issue.message),
		"; ",
	)

const issuesOf = (body: string) =>
	Option.getOrElse(
		Option.flatMap(decodeEnvelope(body), (envelope) => Option.fromNullishOr(envelope.errors)),
		(): ReadonlyArray<GraphqlIssue> => [],
	)

const toRailwayError = (error: VendorHttp.VendorHttpError): RailwayApiError => {
	switch (error.kind) {
		case "rate_limited":
			return new RailwayApiError({
				message: "Railway API rate limit reached",
				kind: "rate_limited",
				...(error.retryAfterSeconds === undefined
					? undefined
					: { retryAfterSeconds: error.retryAfterSeconds }),
			})
		case "unauthorized":
		case "forbidden":
			return new RailwayApiError({ message: "Railway rejected the API token", kind: "unauthorized" })
		case "timeout":
			return new RailwayApiError({ message: "Railway API request timed out", kind: "upstream" })
		default:
			return new RailwayApiError({
				message: `Railway API error: ${Str.slice(0, 300)(error.detail ?? error.message)}`,
				kind: "upstream",
			})
	}
}

/** Railway answers a passing hiccup with "Problem processing request", on a 200 or a 4xx. */
const isProcessingHiccup = (error: VendorHttp.VendorHttpError) =>
	error.kind === "upstream" &&
	(error.status === undefined || error.status < 500) &&
	/problem processing request/i.test(error.detail ?? "")

const client = (httpClient: HttpClient.HttpClient, token: string) =>
	VendorHttp.make({
		httpClient,
		peerService: "railway",
		baseUrl: BASE_URL,
		auth: VendorHttp.bearer(token),
		headers: { accept: "application/graphql-response+json, application/json" },
		classify: (refusal) => issuesKind(issuesOf(refusal.body)),
		detail: (body) => {
			const issues = issuesOf(body)
			return issues.length === 0 ? undefined : issuesMessage(issues)
		},
		toError: (error) => error,
		timeout: REQUEST_TIMEOUT,
	})

type RailwayClient = ReturnType<typeof client>

const graphqlFailure = (operation: string, issues: ReadonlyArray<GraphqlIssue>) => {
	const detail = issuesMessage(issues)
	return new VendorHttp.VendorHttpError({
		message: `railway answered with GraphQL errors while ${operation}`,
		kind: issuesKind(issues) ?? "upstream",
		peerService: "railway",
		operation,
		body: Str.slice(0, 2000)(detail),
		detail: Str.slice(0, 2000)(detail),
	})
}

/**
 * One read-only query. GraphQL errors on a 200 fail like a refusal; a "Problem processing request"
 * is retried here, since the kit only retries a 5xx and a timeout.
 */
const query = <S extends Schema.Top>(
	railway: RailwayClient,
	operationName: string,
	operation: string,
	document: string,
	variables: Readonly<Record<string, unknown>>,
	data: S,
): Effect.Effect<S["Type"], VendorHttp.VendorHttpError, S["DecodingServices"]> =>
	railway
		.json(Envelope, {
			method: "POST",
			path: "/graphql/v2",
			body: { query: document, variables, operationName },
			operation,
			retry: true,
		})
		.pipe(
			Effect.flatMap((envelope) =>
				envelope.errors !== undefined && envelope.errors !== null && envelope.errors.length > 0
					? Effect.fail(graphqlFailure(operation, envelope.errors))
					: Schema.decodeUnknownEffect(data)(envelope.data).pipe(
							Effect.mapError(
								(cause) =>
									new VendorHttp.VendorHttpError({
										message: `railway answered with unexpected data while ${operation}`,
										kind: "invalid_response",
										peerService: "railway",
										operation,
										cause,
									}),
							),
						),
			),
			Effect.retry({ schedule: VENDOR_TRANSIENT_RETRY, while: isProcessingHiccup }),
		)

const TOKEN_WORKSPACES = `query TokenWorkspaces {
  apiToken {
    workspaces {
      id
      name
    }
  }
}`

const TokenWorkspaces = Schema.Struct({
	apiToken: Schema.Struct({
		workspaces: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
	}),
})

/**
 * Nested connections read one page; following each project's cursor would cost a request per
 * project per discovery. A full page is reported as truncated so reconciliation keeps the rest.
 */
const NESTED_PAGE_SIZE = 100
const PROJECT_PAGE_SIZE = 50
/** 2,000 projects per workspace. A longer listing fails rather than reconcile a partial one. */
const MAX_PROJECT_PAGES = 40

const WORKSPACE_PROJECTS = `query WorkspaceProjects($workspaceId: String, $first: Int, $after: String, $nested: Int) {
  projects(workspaceId: $workspaceId, first: $first, after: $after) {
    edges {
      node {
        id
        name
        environments(first: $nested) {
          edges {
            node {
              id
              name
              isEphemeral
            }
          }
        }
        services(first: $nested) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

const edges = <S extends Schema.Top>(node: S) =>
	Schema.Struct({ edges: Schema.Array(Schema.Struct({ node })) })

const WorkspaceProjects = Schema.Struct({
	projects: Schema.Struct({
		edges: Schema.Array(
			Schema.Struct({
				node: Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					environments: edges(
						Schema.Struct({
							id: Schema.String,
							name: Schema.String,
							isEphemeral: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
						}),
					),
					services: edges(Schema.Struct({ id: Schema.String, name: Schema.String })),
				}),
			}),
		),
		pageInfo: Schema.Struct({
			hasNextPage: Schema.Boolean,
			endCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	}),
})

type WorkspaceProject = (typeof WorkspaceProjects.Type)["projects"]["edges"][number]["node"]

/** Every project in the workspace, following the connection cursor page by page. */
const workspaceProjects = (
	railway: RailwayClient,
	workspaceId: string,
): Effect.Effect<ReadonlyArray<WorkspaceProject>, VendorHttp.VendorHttpError> => {
	const page = (
		after: string | null,
		collected: ReadonlyArray<WorkspaceProject>,
		pages: number,
	): Effect.Effect<ReadonlyArray<WorkspaceProject>, VendorHttp.VendorHttpError> =>
		pages >= MAX_PROJECT_PAGES
			? Effect.fail(
					new VendorHttp.VendorHttpError({
						message: `railway listed more than ${MAX_PROJECT_PAGES} pages of projects`,
						kind: "upstream",
						peerService: "railway",
						operation: "listing projects",
						detail: `more than ${MAX_PROJECT_PAGES * PROJECT_PAGE_SIZE} projects in one workspace`,
					}),
				)
			: query(
					railway,
					"WorkspaceProjects",
					"listing projects",
					WORKSPACE_PROJECTS,
					{ workspaceId, first: PROJECT_PAGE_SIZE, after, nested: NESTED_PAGE_SIZE },
					WorkspaceProjects,
				).pipe(
					Effect.flatMap(({ projects }) => {
						const all = [...collected, ...Arr.map(projects.edges, (edge) => edge.node)]
						const cursor = projects.pageInfo.endCursor ?? null
						if (!projects.pageInfo.hasNextPage) return Effect.succeed(all)
						// A partial listing must fail: reconciling it would disable the unseen projects.
						return cursor === null || cursor === after
							? Effect.fail(
									new VendorHttp.VendorHttpError({
										message: "railway paged projects without an advancing cursor",
										kind: "invalid_response",
										peerService: "railway",
										operation: "listing projects",
									}),
								)
							: page(cursor, all, pages + 1)
					}),
				)
	return page(null, [], 0)
}

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
export const discover = Effect.fn("RailwayApi.discover")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
) {
	const railway = client(httpClient, token)
	const { apiToken } = yield* query(
		railway,
		"TokenWorkspaces",
		"listing workspaces",
		TOKEN_WORKSPACES,
		{},
		TokenWorkspaces,
	)
	const workspaces = apiToken.workspaces
	const pages = yield* Effect.forEach(workspaces, (workspace) => workspaceProjects(railway, workspace.id), {
		concurrency: 2,
	})
	const projects = Arr.flatten(pages)
	const discovered = Arr.flatMap(projects, (project) => {
		const services = Rec.fromEntries(
			Arr.map(project.services.edges, ({ node }) => [node.id, node.name] as const),
		)
		return Arr.map(
			Arr.filter(project.environments.edges, ({ node }) => node.isEphemeral !== true),
			({ node }): RailwayDiscoveredEnvironment => ({
				projectId: project.id,
				projectName: project.name,
				environmentId: node.id,
				environmentName: node.name,
				services,
			}),
		)
	})
	// First occurrence wins: a project listed by two workspaces is discovered once.
	const environments = Arr.dedupeWith(discovered, (a, b) => a.environmentId === b.environmentId)
	const truncatedProjectIds = Arr.map(
		Arr.filter(projects, (project) => project.environments.edges.length >= NESTED_PAGE_SIZE),
		(project) => project.id,
	)
	return {
		workspaceNames: Arr.sort(
			Arr.map(workspaces, (workspace) => workspace.name),
			Order.String,
		),
		environments,
		truncatedProjectIds,
	} satisfies RailwayDiscovery
}, Effect.mapError(toRailwayError))

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

const ENVIRONMENT_METRICS = `query EnvironmentMetrics($environmentId: String, $startDate: DateTime!, $endDate: DateTime, $sampleRateSeconds: Int, $averagingWindowSeconds: Int, $groupBy: [MetricTag!], $measurements: [MetricMeasurement!]!) {
  metrics(environmentId: $environmentId, startDate: $startDate, endDate: $endDate, sampleRateSeconds: $sampleRateSeconds, averagingWindowSeconds: $averagingWindowSeconds, groupBy: $groupBy, measurements: $measurements) {
    measurement
    tags {
      serviceId
      deploymentInstanceId
      region
    }
    values {
      ts
      value
    }
  }
}`

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String))

const EnvironmentMetrics = Schema.Struct({
	metrics: Schema.Array(
		Schema.Struct({
			measurement: Schema.String,
			tags: Schema.Struct({
				serviceId: NullableString,
				deploymentInstanceId: NullableString,
				region: NullableString,
			}),
			values: Schema.Array(Schema.Struct({ ts: Schema.Number, value: Schema.Number })),
		}),
	),
})

/** One call for every service and replica in an environment. */
export const fetchEnvironmentMetrics = (
	httpClient: HttpClient.HttpClient,
	token: string,
	window: RailwayMetricsWindow,
): Effect.Effect<ReadonlyArray<RailwayMetricsResult>, RailwayApiError> =>
	query(
		client(httpClient, token),
		"EnvironmentMetrics",
		"reading metrics",
		ENVIRONMENT_METRICS,
		{
			environmentId: window.environmentId,
			startDate: new Date(window.startMs).toISOString(),
			endDate: new Date(window.endMs).toISOString(),
			sampleRateSeconds: window.sampleRateSeconds,
			averagingWindowSeconds: window.sampleRateSeconds,
			groupBy: ["SERVICE_ID", "DEPLOYMENT_INSTANCE_ID"],
			measurements: RAILWAY_MEASUREMENTS,
		},
		EnvironmentMetrics,
	).pipe(
		Effect.mapBoth({ onSuccess: ({ metrics }) => metrics, onFailure: toRailwayError }),
		Effect.withSpan("RailwayApi.fetchEnvironmentMetrics", {
			attributes: { "maple.railway.environment_id": window.environmentId },
		}),
	)
