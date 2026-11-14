// The slice of Tinybird's API the cost source uses: SQL over the `organization.*` service data
// sources, on the one regional host the token belongs to. Tinybird has no spend API, so these are
// usage reads that `normalize.ts` prices. Every failure is one `TinybirdCostApiError`.
import { Array as Arr, Duration, Effect, Option, Redacted, Result, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { CostPullWindow } from "../../CostProvider"
import { addDays } from "../../sync-plan"

const REQUEST_TIMEOUT = Duration.seconds(30)
// Each host's own bound when finding a token's host: a slow unrelated region must not hold up the
// answer of the token's own, nor outlast the 20 seconds a save waits.
const PROBE_TIMEOUT = Duration.seconds(8)

/** Tinybird's regional API hosts, the only hosts a token is ever sent to, with each one's region. */
export const TINYBIRD_HOSTS = [
	{ host: "https://api.tinybird.co", region: "europe-west3" },
	{ host: "https://api.europe-west2.gcp.tinybird.co", region: "europe-west2" },
	{ host: "https://api.us-east.tinybird.co", region: "us-east4" },
	{ host: "https://api.northamerica-northeast2.gcp.tinybird.co", region: "northamerica-northeast2" },
	{ host: "https://api.eu-central-1.aws.tinybird.co", region: "eu-central-1" },
	{ host: "https://api.eu-west-1.aws.tinybird.co", region: "eu-west-1" },
	{ host: "https://api.us-east.aws.tinybird.co", region: "us-east-1" },
	{ host: "https://api.us-west-2.aws.tinybird.co", region: "us-west-2" },
	{ host: "https://api.ap-east-1.aws.tinybird.co", region: "ap-east-1" },
	{ host: "https://api.ap-southeast-2.aws.tinybird.co", region: "ap-southeast-2" },
] as const

export type TinybirdHost = (typeof TINYBIRD_HOSTS)[number]

/**
 * `elsewhere`: the token is not this host's (Tinybird says "Workspace not found"). `unauthorized`:
 * the token itself is invalid. `forbidden`: the host knows the token, which may not read this.
 */
export class TinybirdCostApiError extends Schema.TaggedError<TinybirdCostApiError>()(
	"@maple/backend/cost/TinybirdCostApiError",
	{
		message: Schema.String,
		kind: Schema.Literals([
			"elsewhere",
			"unauthorized",
			"forbidden",
			"bad_request",
			"rate_limited",
			"invalid_response",
			"upstream",
		]),
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const ErrorBody = Schema.Struct({ error: Schema.String })

const errorKind = (status: number, text: string): TinybirdCostApiError["kind"] => {
	if (status === 401 || status === 403) {
		if (Str.includes("Workspace not found")(text)) return "elsewhere"
		if (Str.includes("invalid authentication token")(text)) return "unauthorized"
		return "forbidden"
	}
	if (status === 429) return "rate_limited"
	return status >= 400 && status < 500 ? "bad_request" : "upstream"
}

/** The `error` text of a refusal, '' when the body is not Tinybird's JSON. */
const errorText = (body: unknown): string =>
	Option.match(Schema.decodeUnknownOption(ErrorBody)(body), {
		onNone: () => "",
		onSome: (decoded) => decoded.error,
	})

/** The rows of `sql` on `host`, decoded with `row`. */
const query = <S extends Schema.Top>(
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	host: TinybirdHost,
	sql: string,
	row: S,
	timeout: Duration.Duration = REQUEST_TIMEOUT,
) => {
	const failed = (kind: TinybirdCostApiError["kind"], what: string) => (cause: unknown) =>
		Effect.fail(new TinybirdCostApiError({ message: `Tinybird API ${what}`, kind, cause }))
	return Effect.gen(function* () {
		const request = HttpClientRequest.get(`${host.host}/v0/sql`).pipe(
			HttpClientRequest.setUrlParams({ q: `${sql} FORMAT JSON` }),
			HttpClientRequest.setHeaders({ authorization: `Bearer ${Redacted.value(token)}` }),
		)
		const response = yield* httpClient.execute(request)
		if (response.status >= 300) {
			const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
			return yield* new TinybirdCostApiError({
				message: `Tinybird API answered ${response.status}`,
				kind: errorKind(response.status, errorText(body)),
				status: response.status,
			})
		}
		// A 2xx that is not JSON is an answer Maple cannot read, not a failed request.
		const body = yield* response.json.pipe(
			Effect.catchTag(
				"HttpClientError",
				failed("invalid_response", "answered with a body that is not JSON"),
			),
		)
		const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(row) }))(body)
		return decoded.data
	}).pipe(
		Effect.timeout(timeout),
		Effect.catchTags({
			HttpClientError: failed("upstream", "request failed"),
			TimeoutError: failed("upstream", "request timed out"),
			SchemaError: failed("invalid_response", "answered with a body Maple cannot read"),
		}),
		// A redirect is not Tinybird answering, so the token is never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "tinybird"),
	)
}

const Identity = Schema.Struct({
	workspace_id: Schema.String,
	workspace_name: Schema.String,
	/** '' when the organization had no shared-infrastructure minute in 90 days. */
	organization_name: Schema.String,
})
export type TinybirdIdentity = typeof Identity.Type

// The organization is known by its oldest workspace, deleted ones included: every organization has
// one and it never changes, where only shared plans record the organization's own id.
const IDENTITY_SQL =
	"SELECT w.workspace_id AS workspace_id, w.name AS workspace_name, (SELECT any(organization_name) FROM organization.shared_infra_active_minutes WHERE minute >= now() - INTERVAL 90 DAY) AS organization_name FROM organization.workspaces w ORDER BY w.created_at, w.workspace_id LIMIT 1"

/**
 * Why no host answered for a token. `rejected`: no host knows it. `no_scope`: its own host refuses
 * it the organization's data. `upstream` and `rate_limited`: some host could not be asked.
 */
export class TinybirdHostError extends Schema.TaggedError<TinybirdHostError>()(
	"@maple/backend/cost/TinybirdHostError",
	{
		message: Schema.String,
		kind: Schema.Literals(["rejected", "no_scope", "rate_limited", "upstream", "invalid_response"]),
	},
) {}

export interface ResolvedHost {
	readonly host: TinybirdHost
	/** The organization, none when it has no workspace at all. */
	readonly identity: Option.Option<TinybirdIdentity>
}

/**
 * The token's host, found by asking every host who the organization is at once: a token works on
 * one host only. Requests to Tinybird's API are free, so the pull resolves it again each time.
 */
export const resolveHost = Effect.fn("TinybirdCost.resolveHost")(function* (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
) {
	const answers = yield* Effect.forEach(
		TINYBIRD_HOSTS,
		(host) =>
			Effect.result(query(httpClient, token, host, IDENTITY_SQL, Identity, PROBE_TIMEOUT)).pipe(
				Effect.map((answer) => ({ host, answer })),
			),
		{ concurrency: "unbounded" },
	)
	const answered = Arr.findFirst(answers, ({ answer }) => Result.isSuccess(answer))
	if (Option.isSome(answered) && Result.isSuccess(answered.value.answer)) {
		const { host, answer } = answered.value
		yield* Effect.annotateCurrentSpan({ "maple.cost.tinybird.region": host.region })
		return { host, identity: Arr.head(answer.success) } satisfies ResolvedHost
	}
	const kinds = Arr.map(Arr.getFailures(Arr.map(answers, ({ answer }) => answer)), (error) => error.kind)
	yield* Effect.annotateCurrentSpan({ "maple.cost.tinybird.refusals": Arr.join(kinds, ",") })
	// The token's own host refuses it the data; every other host does not know it.
	const refusing = Arr.filter(kinds, (kind) => kind === "forbidden" || kind === "bad_request")
	if (refusing.length === 1) {
		return yield* new TinybirdHostError({
			message: "The token cannot read the organization",
			kind: "no_scope",
		})
	}
	const unanswered = Arr.findFirst(kinds, (kind) => kind === "upstream" || kind === "invalid_response")
	if (Arr.contains(kinds, "rate_limited")) {
		return yield* new TinybirdHostError({
			message: "A Tinybird host is rate limiting",
			kind: "rate_limited",
		})
	}
	if (Option.isSome(unanswered)) {
		return yield* new TinybirdHostError({
			message: "A Tinybird host did not answer",
			kind: unanswered.value === "invalid_response" ? "invalid_response" : "upstream",
		})
	}
	return yield* new TinybirdHostError({ message: "No Tinybird host knows the token", kind: "rejected" })
})

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The window as SQL datetimes, end exclusive, or none when a day is not `YYYY-MM-DD`. */
const windowBounds = (window: CostPullWindow) =>
	DAY.test(window.startDay) && DAY.test(window.endDay)
		? Effect.succeed({
				from: `toDateTime('${window.startDay} 00:00:00')`,
				to: `toDateTime('${addDays(window.endDay, 1)} 00:00:00')`,
			})
		: Effect.fail(
				new TinybirdCostApiError({
					message: "The window's days are not YYYY-MM-DD",
					kind: "bad_request",
				}),
			)

export const Workspace = Schema.Struct({
	workspace_id: Schema.String,
	name: Schema.String,
	/** 1 while the workspace is not deleted. */
	live: Schema.Number,
})
export type Workspace = typeof Workspace.Type

/** Every workspace of the organization, deleted ones included. */
export const getWorkspaces = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	host: TinybirdHost,
) =>
	query(
		httpClient,
		token,
		host,
		"SELECT workspace_id, name, toUInt8(isNull(deleted_at)) AS live FROM organization.workspaces",
		Workspace,
	)

export const ComputeDay = Schema.Struct({ day: Schema.String, overage_seconds: Schema.Number })
export type ComputeDay = typeof ComputeDay.Type

/** vCPU-seconds above the plan's vCPUs, per day: each second's use over that minute's vCPUs. */
export const getComputeOverage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	host: TinybirdHost,
	window: CostPullWindow,
) =>
	Effect.flatMap(windowBounds(window), ({ from, to }) =>
		query(
			httpClient,
			token,
			host,
			`SELECT toString(toDate(s.second_slot)) AS day, toFloat64(sum(greatest(s.cpu_time - m.vcpus, 0))) AS overage_seconds FROM organization.shared_infra_active_seconds s LEFT JOIN (SELECT minute, max(vcpus) AS vcpus FROM organization.shared_infra_active_minutes WHERE minute >= ${from} AND minute < ${to} GROUP BY minute) m ON toStartOfMinute(s.second_slot) = m.minute WHERE s.second_slot >= ${from} AND s.second_slot < ${to} GROUP BY day`,
			ComputeDay,
		),
	)

export const StorageDay = Schema.Struct({
	day: Schema.String,
	workspace_id: Schema.String,
	bytes: Schema.Number,
})
export type StorageDay = typeof StorageDay.Type

/** Per day and workspace, the sum over data sources of each one's largest size that day. */
export const getStorage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	host: TinybirdHost,
	window: CostPullWindow,
) =>
	Effect.flatMap(windowBounds(window), ({ from, to }) =>
		query(
			httpClient,
			token,
			host,
			`SELECT toString(day) AS day, workspace_id, toFloat64(sum(day_bytes)) AS bytes FROM (SELECT toDate(timestamp) AS day, workspace_id, datasource_id, max(bytes + bytes_quarantine) AS day_bytes FROM organization.datasources_storage WHERE timestamp >= ${from} AND timestamp < ${to} GROUP BY day, workspace_id, datasource_id) GROUP BY day, workspace_id`,
			StorageDay,
		),
	)

export const TransferDay = Schema.Struct({
	day: Schema.String,
	workspace_id: Schema.String,
	kind: Schema.String,
	bytes: Schema.Number,
})
export type TransferDay = typeof TransferDay.Type

/** Bytes moved per day, workspace and kind ('intra' or 'inter' region). */
export const getTransfer = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	host: TinybirdHost,
	window: CostPullWindow,
) =>
	Effect.flatMap(windowBounds(window), ({ from, to }) =>
		query(
			httpClient,
			token,
			host,
			`SELECT toString(toDate(timestamp)) AS day, workspace_id, toString(kind) AS kind, toFloat64(sum(bytes)) AS bytes FROM organization.data_transfer WHERE timestamp >= ${from} AND timestamp < ${to} GROUP BY day, workspace_id, kind`,
			TransferDay,
		),
	)
