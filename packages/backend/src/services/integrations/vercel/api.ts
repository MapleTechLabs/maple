/**
 * The slice of Vercel's REST API the integration uses: teams, projects, deployments and drains.
 * No Effect SDK exists, so this decodes only the fields Maple reads. Failures fold into one
 * {@link VercelApiError} whose `kind` drives the poller (auth failure, back-off, missing drain).
 */
import { Duration, Effect, Option, Schema, Stream, Array as Arr, Record as Rec, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../vendor-http"

const BASE_URL = "https://api.vercel.com"
const REQUEST_TIMEOUT = Duration.seconds(20)
const CHARGES_TIMEOUT = Duration.seconds(60)
const PAGE_SIZE = 100
const MAX_PROJECT_PAGES = 10
const MAX_TEAM_PAGES = 10

export class VercelApiError extends Schema.TaggedError<VercelApiError>()(
	"@maple/backend/integrations/VercelApiError",
	{
		message: Schema.String,
		// `invalid_response`: a 2xx answer Maple could not read. Only the charges read tells it from `upstream`.
		kind: Schema.Literals([
			"unauthorized",
			"forbidden",
			"rate_limited",
			"not_found",
			"upstream",
			"invalid_response",
		]),
		status: Schema.optionalKey(Schema.Number),
		/** Vercel's own error message, without the status prefix. */
		detail: Schema.optionalKey(Schema.String),
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const ErrorBody = Schema.Struct({
	error: Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
})
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

/** A failed call as the error callers branch on, with Vercel's own message when the body has one. */
const toVercelError = (error: VendorHttp.VendorHttpError): VercelApiError => {
	const cut = error.detail === undefined ? undefined : Str.slice(0, 300)(error.detail)
	const message =
		error.status !== undefined
			? `Vercel API returned ${error.status}${cut === undefined ? "" : `: ${cut}`}`
			: error.kind === "timeout"
				? "Vercel API request timed out"
				: error.kind === "invalid_response"
					? "Vercel API answered with an unexpected body"
					: "Vercel API request failed"
	return new VercelApiError({
		message,
		// A decode failure outside the charges read stays `upstream`, as callers have always seen it.
		kind: error.kind === "timeout" || error.kind === "invalid_response" ? "upstream" : error.kind,
		...(error.status === undefined ? undefined : { status: error.status }),
		...(cut === undefined ? undefined : { detail: cut }),
		...(error.retryAfterSeconds === undefined
			? undefined
			: { retryAfterSeconds: error.retryAfterSeconds }),
		...(error.cause === undefined ? undefined : { cause: error.cause }),
	})
}

const client = (httpClient: HttpClient.HttpClient, token: string) =>
	VendorHttp.make({
		httpClient,
		peerService: "vercel",
		baseUrl: BASE_URL,
		auth: VendorHttp.bearer(token),
		toError: toVercelError,
		detail: (body) => Option.getOrUndefined(decodeErrorBody(body))?.error.message,
		timeout: REQUEST_TIMEOUT,
	})

type Cursor = string | number

/**
 * The next page of a listing. Vercel pages backwards with `until=<timestamp>`; a listing that
 * answers with a continuation token instead takes it back as `from=<token>`.
 */
const pageFrom = (next: Option.Option<Cursor>): Readonly<Record<string, string>> =>
	Option.match(next, {
		onNone: () => ({}),
		onSome: (cursor): Readonly<Record<string, string>> =>
			typeof cursor === "string" ? { from: cursor } : { until: String(cursor) },
	})

const Pagination = Schema.Struct({
	next: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
})

const nextOf = (body: { readonly pagination?: typeof Pagination.Type }): Option.Option<Cursor> =>
	Option.fromNullishOr(body.pagination?.next)

// Teams

export interface VercelTeamInfo {
	readonly id: string
	readonly slug: string
	readonly name: string
	/** Null for a team the token sees only in part (Vercel's `limited` teams). */
	readonly plan: string | null
}

const TeamsBody = Schema.Struct({
	teams: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			slug: Schema.String,
			name: Schema.optionalKey(Schema.NullOr(Schema.String)),
			billing: Schema.optionalKey(
				Schema.NullOr(Schema.Struct({ plan: Schema.optionalKey(Schema.String) })),
			),
		}),
	),
	pagination: Schema.optionalKey(Pagination),
})

/** Every team the token sees, up to {@link MAX_TEAM_PAGES} pages. */
export const listTeams = Effect.fn("VercelApi.listTeams")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
) {
	const { pages } = yield* client(httpClient, token).paginate({
		schema: TeamsBody,
		maxPages: MAX_TEAM_PAGES,
		next: nextOf,
		request: (next) => ({ path: "/v2/teams", query: { limit: String(PAGE_SIZE), ...pageFrom(next) } }),
	})
	return Arr.flatMap(pages, (body) =>
		Arr.map(body.teams, (team): VercelTeamInfo => ({
			id: team.id,
			slug: team.slug,
			name: team.name ?? team.slug,
			plan: team.billing?.plan ?? null,
		})),
	)
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
	const { pages, complete } = yield* client(httpClient, token).paginate({
		schema: ProjectsBody,
		maxPages: MAX_PROJECT_PAGES,
		next: nextOf,
		request: (next) => ({
			path: "/v10/projects",
			query: { teamId, limit: String(PAGE_SIZE), ...pageFrom(next) },
		}),
	})
	const projects = Arr.flatMap(pages, (body) =>
		Arr.map(body.projects, (project): VercelProjectInfo => ({
			id: project.id,
			name: project.name,
			framework: project.framework ?? null,
			productionDeploymentId: project.targets?.production?.id ?? null,
		})),
	)
	yield* Effect.annotateCurrentSpan({
		"maple.vercel.projects": projects.length,
		"maple.vercel.projects_complete": complete,
	})
	return { projects, complete } satisfies VercelProjectListing
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
	readonly errorMessage: string | null
	readonly createdAt: number
	readonly buildingAt: number | null
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
			buildingAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			ready: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			errorCode: Schema.optionalKey(Schema.NullOr(Schema.String)),
			errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
	const { pages } = yield* client(httpClient, token).paginate({
		schema: DeploymentsBody,
		maxPages,
		next: nextOf,
		request: (next) => ({
			path: "/v7/deployments",
			query: { teamId, limit: String(PAGE_SIZE), since: String(sinceMs), ...pageFrom(next) },
		}),
	})
	const deployments = Arr.flatMap(pages, (body) =>
		Arr.flatMap(body.deployments, (d): Array<VercelDeploymentInfo> =>
			d.projectId === undefined
				? []
				: [
						{
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
							errorMessage: d.errorMessage ?? null,
							createdAt: d.created,
							buildingAt: d.buildingAt ?? null,
							readyAt: d.ready ?? null,
							inspectorUrl: d.inspectorUrl ?? null,
						},
					],
		),
	)
	yield* Effect.annotateCurrentSpan("maple.vercel.deployments", deployments.length)
	return deployments
})

// Drains

/** The create/update body Maple sends: one drain per data kind, owned by Maple. */
export interface VercelDrainBody {
	readonly name: string
	readonly projects: "all" | "some"
	/** Null on an update clears the list a `some` drain had. */
	readonly projectIds?: ReadonlyArray<string> | null
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

const drainPath = (drainId?: string) =>
	`/v1/drains${drainId === undefined ? "" : `/${encodeURIComponent(drainId)}`}`

export const createDrain = Effect.fn("VercelApi.createDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	body: VercelDrainBody,
) {
	const drain = yield* client(httpClient, token).json(DrainBody, {
		method: "POST",
		path: drainPath(),
		query: { teamId },
		body,
	})
	return toDrainInfo(drain)
})

export const updateDrain = Effect.fn("VercelApi.updateDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	drainId: string,
	body: VercelDrainBody,
) {
	const drain = yield* client(httpClient, token).json(DrainBody, {
		method: "PATCH",
		path: drainPath(drainId),
		query: { teamId },
		body,
	})
	return toDrainInfo(drain)
})

export interface VercelListedDrain extends VercelDrainInfo {
	readonly createdAt: number
	/** The delivery URL: the endpoint of an HTTP drain, `endpoint.traces` of an OTLP one. */
	readonly endpoint: string | null
	/** Empty for a drain that forwards every project. */
	readonly projectIds: ReadonlyArray<string>
	readonly sampling: ReadonlyArray<{
		readonly type: string
		readonly rate: number
		readonly env?: string
		readonly requestPath?: string
	}>
	/** The data kinds it carries (`log`, `trace`, ...). */
	readonly schemas: ReadonlyArray<string>
}

const ListedDrainsBody = Schema.Struct({
	drains: Schema.Array(
		Schema.Struct({
			...DrainBody.fields,
			createdAt: Schema.Number,
			projectIds: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
			sampling: Schema.optionalKey(
				Schema.NullOr(
					Schema.Array(
						Schema.Struct({
							type: Schema.String,
							rate: Schema.Number,
							env: Schema.optionalKey(Schema.String),
							requestPath: Schema.optionalKey(Schema.String),
						}),
					),
				),
			),
			schemas: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
			// Unknown: drains of other delivery types (S3, ClickHouse, ...) list here too.
			delivery: Schema.optionalKey(Schema.Struct({ endpoint: Schema.optionalKey(Schema.Unknown) })),
		}),
	),
})

const endpointOf = (endpoint: unknown): string | null =>
	typeof endpoint === "string"
		? endpoint
		: typeof endpoint === "object" &&
			  endpoint !== null &&
			  "traces" in endpoint &&
			  typeof endpoint.traces === "string"
			? endpoint.traces
			: null

/** Every drain of the team, Maple's or not. Delivery headers are not read: Vercel may redact them. */
export const listDrains = Effect.fn("VercelApi.listDrains")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
) {
	const body = yield* client(httpClient, token).json(ListedDrainsBody, {
		path: drainPath(),
		query: { teamId },
	})
	yield* Effect.annotateCurrentSpan("maple.vercel.drains", body.drains.length)
	return Arr.map(body.drains, (drain): VercelListedDrain => ({
		...toDrainInfo(drain),
		createdAt: drain.createdAt,
		endpoint: endpointOf(drain.delivery?.endpoint),
		projectIds: drain.projectIds ?? [],
		sampling: drain.sampling ?? [],
		schemas: Rec.keys(drain.schemas ?? {}),
	}))
})

/** Deletes a drain; one that is already gone (404/410) counts as deleted. */
export const deleteDrain = Effect.fn("VercelApi.deleteDrain")(function* (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	drainId: string,
) {
	yield* client(httpClient, token)
		.json(Schema.Unknown, { method: "DELETE", path: drainPath(drainId), query: { teamId } })
		.pipe(
			Effect.catchIf(
				(error) => error.kind === "not_found",
				() => Effect.void,
			),
		)
})

// Billing

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/** An ISO 8601 date-time in UTC, to the minute at least: `2026-11-02T00:00:00.000Z`. */
const UTC_DATE_TIME =
	/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]00:00)$/

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const daysInMonth = (year: number, month: number): number =>
	month === 2 ? (isLeapYear(year) ? 29 : 28) : Arr.contains([4, 6, 9, 11], month) ? 30 : 31

/** Whether the day a date-time starts with exists: no February 31st, a February 29th in leap years only. */
const startsWithRealDay = (value: string): boolean =>
	Number(Str.slice(8, 10)(value)) <=
	daysInMonth(Number(Str.slice(0, 4)(value)), Number(Str.slice(5, 7)(value)))

/**
 * One line of the charges answer: a FOCUS v1.3 charge. The shape is Vercel's OpenAPI spec, not a
 * recorded answer, so everything Maple can do without is optional and may be null.
 */
export const VercelCharge = Schema.Struct({
	// Finite: `1e309` is valid JSON and parses as Infinity, which no sum or store survives.
	BilledCost: Schema.Finite,
	/** Inclusive, ISO 8601 in UTC: its first ten characters are the usage day. */
	ChargePeriodStart: Schema.String.check(
		Schema.isPattern(UTC_DATE_TIME),
		Schema.makeFilter(startsWithRealDay, { expected: "a date-time on a day of the calendar" }),
	),
	/** The product's display name. */
	ServiceName: Schema.String,
	BillingCurrency: optional(Schema.String),
	/** `Usage`, `Purchase`, `Credit`, `Tax` or `Adjustment`. */
	ChargeCategory: optional(Schema.String),
	/** Null when the charge is not usage. */
	ConsumedQuantity: optional(Schema.Finite),
	ConsumedUnit: optional(Schema.String),
	EffectiveCost: optional(Schema.Finite),
	RegionId: optional(Schema.String),
	/** A FOCUS category: `Compute`, `Networking`, `Storage`, ... */
	ServiceCategory: optional(Schema.String),
	/** The product's stable id. */
	SkuId: optional(Schema.String),
	Tags: optional(
		Schema.Struct({ ProjectId: optional(Schema.String), ProjectName: optional(Schema.String) }),
	),
})
export type VercelCharge = typeof VercelCharge.Type

const decodeChargeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(VercelCharge))

/**
 * The team's billed charges from `from` (inclusive) to `to` (exclusive), both ISO 8601 in UTC, one
 * per line of the JSONL answer as it streams in. Blank lines are skipped. A line that is not a
 * charge fails the read as `invalid_response`.
 */
export const streamBillingCharges = (
	httpClient: HttpClient.HttpClient,
	token: string,
	teamId: string,
	range: { readonly from: string; readonly to: string },
): Stream.Stream<VercelCharge, VercelApiError> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const response = yield* client(httpClient, token).stream({
				path: "/v1/billing/charges",
				query: { teamId, from: range.from, to: range.to },
				// Until the answer starts: a long range can take Vercel a while to begin streaming.
				timeout: CHARGES_TIMEOUT,
			})
			// Only a 200 is the whole range: a 204 or a 206 would store days empty or by halves.
			if (response.status !== 200) {
				return yield* new VercelApiError({
					message: `Vercel API answered ${response.status} where the charges are a 200`,
					kind: "invalid_response",
					status: response.status,
				})
			}
			return response.body.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.map(Str.trim),
				Stream.filter(Str.isNonEmpty),
				Stream.mapEffect((line) =>
					decodeChargeLine(line).pipe(
						Effect.mapError(
							(cause) =>
								new VercelApiError({
									message: "Vercel API answered with a charge Maple could not read",
									kind: "invalid_response",
									cause,
								}),
						),
					),
				),
			)
		}),
	)
