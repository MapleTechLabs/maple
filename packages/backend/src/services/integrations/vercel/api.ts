/**
 * The slice of Vercel's REST API the integration uses: teams, projects, deployments and drains.
 * No Effect SDK exists, so this decodes only the fields Maple reads. Failures fold into one
 * {@link VercelApiError} whose `kind` drives the poller (auth failure, back-off, missing drain).
 */
import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

const BASE_URL = "https://api.vercel.com"
const REQUEST_TIMEOUT = Duration.seconds(20)
const PAGE_SIZE = 100
const MAX_PROJECT_PAGES = 10
const MAX_TEAM_PAGES = 10

export class VercelApiError extends Schema.TaggedError<VercelApiError>()(
	"@maple/backend/integrations/VercelApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "not_found", "upstream"]),
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const ErrorBody = Schema.Struct({
	error: Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
})
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

const errorKind = (status: number): VercelApiError["kind"] =>
	status === 401
		? "unauthorized"
		: status === 403
			? "forbidden"
			: status === 404 || status === 410
				? "not_found"
				: status === 429
					? "rate_limited"
					: "upstream"

const call = <S extends Schema.Top>(
	httpClient: HttpClient.HttpClient,
	token: string,
	request: HttpClientRequest.HttpClientRequest,
	schema: S,
): Effect.Effect<S["Type"], VercelApiError, S["DecodingServices"]> => {
	const failed = (what: string) => (cause: unknown) =>
		Effect.fail(new VercelApiError({ message: `Vercel API ${what}`, kind: "upstream", cause }))
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(HttpClientRequest.bearerToken(request, token))
		const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
		if (response.status >= 300) {
			const detail = Option.getOrUndefined(decodeErrorBody(body))?.error.message
			return yield* new VercelApiError({
				message: `Vercel API returned ${response.status}${detail === undefined ? "" : `: ${detail.slice(0, 300)}`}`,
				kind: errorKind(response.status),
				status: response.status,
			})
		}
		return yield* Schema.decodeUnknownEffect(schema)(body)
	}).pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTags({
			HttpClientError: failed("request failed"),
			TimeoutError: failed("request timed out"),
			SchemaError: failed("answered with an unexpected body"),
		}),
		Effect.annotateSpans("peer.service", "vercel"),
	)
}

const teamUrl = (path: string, teamId: string, params: Record<string, string> = {}) =>
	HttpClientRequest.setUrlParams(HttpClientRequest.get(`${BASE_URL}${path}`), { teamId, ...params })

/**
 * The next page of a listing. Vercel pages backwards with `until=<timestamp>`; a listing that
 * answers with a continuation token instead takes it back as `from=<token>`.
 */
const pageFrom = (request: HttpClientRequest.HttpClientRequest, next: string | number | null) =>
	next === null
		? request
		: typeof next === "string"
			? HttpClientRequest.setUrlParam(request, "from", next)
			: HttpClientRequest.setUrlParam(request, "until", String(next))

const Pagination = Schema.Struct({
	next: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
})

// Teams

export interface VercelTeamInfo {
	readonly id: string
	readonly slug: string
	readonly name: string
}

const TeamsBody = Schema.Struct({
	teams: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			slug: Schema.String,
			name: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	pagination: Schema.optionalKey(Pagination),
})

/** Every team the token sees, up to {@link MAX_TEAM_PAGES} pages. */
export const listTeams = Effect.fn("VercelApi.listTeams")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
) {
	const teams: Array<VercelTeamInfo> = []
	let next: string | number | null = null
	for (let page = 0; page < MAX_TEAM_PAGES; page++) {
		const body: typeof TeamsBody.Type = yield* call(
			httpClient,
			token,
			pageFrom(
				HttpClientRequest.setUrlParams(HttpClientRequest.get(`${BASE_URL}/v2/teams`), {
					limit: String(PAGE_SIZE),
				}),
				next,
			),
			TeamsBody,
		)
		for (const team of body.teams) {
			teams.push({ id: team.id, slug: team.slug, name: team.name ?? team.slug })
		}
		next = body.pagination?.next ?? null
		if (next === null) break
	}
	return teams
})

// Projects

export interface VercelProjectInfo {
	readonly id: string
	readonly name: string
	readonly framework: string | null
	readonly productionDeploymentId: string | null
}

const ProjectsBody = Schema.Struct({
	projects: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			framework: Schema.optionalKey(Schema.NullOr(Schema.String)),
			targets: Schema.optionalKey(
				Schema.NullOr(
					Schema.Struct({
						production: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
					}),
				),
			),
		}),
	),
	pagination: Schema.optionalKey(Pagination),
})

export interface VercelProjectListing {
	readonly projects: ReadonlyArray<VercelProjectInfo>
	/** False when the page cap cut the listing short: projects past it were not seen. */
	readonly complete: boolean
}

/** The team's projects, following `pagination.next` up to {@link MAX_PROJECT_PAGES} pages. */
export const listProjects = Effect.fn("VercelApi.listProjects")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
) {
	const projects: Array<VercelProjectInfo> = []
	let next: string | number | null = null
	for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
		const body: typeof ProjectsBody.Type = yield* call(
			httpClient,
			token,
			pageFrom(teamUrl("/v10/projects", teamId, { limit: String(PAGE_SIZE) }), next),
			ProjectsBody,
		)
		for (const project of body.projects) {
			projects.push({
				id: project.id,
				name: project.name,
				framework: project.framework ?? null,
				productionDeploymentId: project.targets?.production?.id ?? null,
			})
		}
		next = body.pagination?.next ?? null
		if (next === null) break
	}
	yield* Effect.annotateCurrentSpan({
		"maple.vercel.projects": projects.length,
		"maple.vercel.projects_complete": next === null,
	})
	return { projects, complete: next === null } satisfies VercelProjectListing
})

// Deployments

export interface VercelDeploymentInfo {
	readonly id: string
	readonly projectId: string
	readonly url: string
	readonly target: string | null
	readonly state: string
	readonly branch: string | null
	readonly commitSha: string | null
	readonly commitMessage: string | null
	readonly creator: string | null
	readonly errorCode: string | null
	readonly createdAt: number
	readonly readyAt: number | null
	readonly inspectorUrl: string | null
}

const DeploymentsBody = Schema.Struct({
	deployments: Schema.Array(
		Schema.Struct({
			uid: Schema.String,
			url: Schema.optionalKey(Schema.NullOr(Schema.String)),
			created: Schema.Number,
			state: Schema.optionalKey(Schema.String),
			readyState: Schema.optionalKey(Schema.String),
			target: Schema.optionalKey(Schema.NullOr(Schema.String)),
			projectId: Schema.optionalKey(Schema.String),
			meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
			creator: Schema.optionalKey(Schema.Struct({ username: Schema.optionalKey(Schema.String) })),
			ready: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			errorCode: Schema.optionalKey(Schema.NullOr(Schema.String)),
			inspectorUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	pagination: Schema.optionalKey(Pagination),
})

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const

/** `meta.<provider><field>` for whichever git provider built the deployment. */
const gitMeta = (meta: Readonly<Record<string, unknown>> | undefined, field: string): string | null => {
	for (const provider of GIT_PROVIDERS) {
		const value = meta?.[`${provider}${field}`]
		if (typeof value === "string" && value !== "") return value
	}
	return null
}

/** Deployments of the whole team created since `sinceMs`, newest first, at most `maxPages` pages. */
export const listDeployments = Effect.fn("VercelApi.listDeployments")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	sinceMs: number,
	maxPages: number,
) {
	const deployments: Array<VercelDeploymentInfo> = []
	let next: string | number | null = null
	for (let page = 0; page < maxPages; page++) {
		const body: typeof DeploymentsBody.Type = yield* call(
			httpClient,
			token,
			pageFrom(
				teamUrl("/v6/deployments", teamId, { limit: String(PAGE_SIZE), since: String(sinceMs) }),
				next,
			),
			DeploymentsBody,
		)
		for (const d of body.deployments) {
			if (d.projectId === undefined) continue
			deployments.push({
				id: d.uid,
				projectId: d.projectId,
				url: d.url ?? "",
				target: d.target ?? null,
				state: d.readyState ?? d.state ?? "UNKNOWN",
				branch: gitMeta(d.meta, "CommitRef"),
				commitSha: gitMeta(d.meta, "CommitSha"),
				commitMessage: gitMeta(d.meta, "CommitMessage"),
				creator: d.creator?.username ?? null,
				errorCode: d.errorCode ?? null,
				createdAt: d.created,
				readyAt: d.ready ?? null,
				inspectorUrl: d.inspectorUrl ?? null,
			})
		}
		next = body.pagination?.next ?? null
		if (next === null) break
	}
	yield* Effect.annotateCurrentSpan("maple.vercel.deployments", deployments.length)
	return deployments
})

// Drains

/** The create/update body Maple sends: one drain per data kind, owned by Maple. */
export interface VercelDrainBody {
	readonly name: string
	readonly projects: "all" | "some"
	readonly projectIds?: ReadonlyArray<string>
	readonly schemas: Readonly<Record<string, { readonly version: string }>>
	readonly delivery: Readonly<Record<string, unknown>>
	readonly sampling?: ReadonlyArray<{ readonly type: "head_sampling"; readonly rate: number }>
	/** Update only: re-enables a drain Vercel or the team disabled. */
	readonly status?: "enabled"
}

const DrainBody = Schema.Struct({
	id: Schema.String,
	status: Schema.optionalKey(Schema.String),
	disabledReason: Schema.optionalKey(Schema.String),
})

export interface VercelDrainInfo {
	readonly id: string
	readonly status: string | null
	readonly disabledReason: string | null
}

const toDrainInfo = (drain: typeof DrainBody.Type): VercelDrainInfo => ({
	id: drain.id,
	status: drain.status ?? null,
	disabledReason: drain.disabledReason ?? null,
})

const drainUrl = (teamId: string, drainId?: string) =>
	`${BASE_URL}/v1/drains${drainId === undefined ? "" : `/${encodeURIComponent(drainId)}`}?teamId=${encodeURIComponent(teamId)}`

export const createDrain = Effect.fn("VercelApi.createDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	body: VercelDrainBody,
) {
	const drain = yield* call(
		httpClient,
		token,
		HttpClientRequest.post(drainUrl(teamId)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
		DrainBody,
	)
	return toDrainInfo(drain)
})

export const updateDrain = Effect.fn("VercelApi.updateDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	drainId: string,
	body: VercelDrainBody,
) {
	const drain = yield* call(
		httpClient,
		token,
		HttpClientRequest.patch(drainUrl(teamId, drainId)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
		DrainBody,
	)
	return toDrainInfo(drain)
})

export const getDrain = Effect.fn("VercelApi.getDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	drainId: string,
) {
	return toDrainInfo(
		yield* call(httpClient, token, HttpClientRequest.get(drainUrl(teamId, drainId)), DrainBody),
	)
})

/** Deletes a drain; one that is already gone (404/410) counts as deleted. */
export const deleteDrain = Effect.fn("VercelApi.deleteDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	drainId: string,
) {
	yield* call(httpClient, token, HttpClientRequest.delete(drainUrl(teamId, drainId)), Schema.Unknown).pipe(
		Effect.catchIf(
			(error) => error.kind === "not_found",
			() => Effect.void,
		),
	)
})
