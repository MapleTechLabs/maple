// BOUNDARY-FILE: This module intentionally carries opaque values; callers decode them before domain use.
/**
 * Cloudflare's REST and GraphQL Analytics APIs on the vendor HTTP kit, keyed on an access token.
 *
 * Stateless on purpose: `CloudflareOAuthService` needs `listAccounts` during `completeConnect`
 * (before a connection row exists), so depending on it would be circular. Callers with a
 * connection resolve a fresh token through `CloudflareOAuthService.getValidAccessToken`.
 */
import { IntegrationsRevokedError, IntegrationsUpstreamError } from "@maple/domain/http"
import { Array as Arr, Duration, Effect, Option, Schedule, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import * as VendorHttp from "./vendor-http"

/**
 * Auth blips outlast a 5xx: the SDK retried them 8 times, and one that survives the retries
 * reads as a revoked grant, which turns the org's datasets off. Keep the same patience.
 */
const AUTH_BLIP_RETRY = Schedule.max([
	Schedule.jittered(Schedule.exponential("500 millis")).pipe(
		Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5)))),
	),
	Schedule.recurs(8),
])

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4"
/** Per attempt; a GraphQL Analytics query over many zones can take a while. */
const REQUEST_TIMEOUT = Duration.seconds(30)
const PAGE_SIZE = 50

/** Any failure a Cloudflare API call can surface to callers, mapped onto Maple's integration errors. */
export type CloudflareApiError = IntegrationsUpstreamError | IntegrationsRevokedError

const EnvelopeError = Schema.Struct({
	code: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	message: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
type EnvelopeError = typeof EnvelopeError.Type

const EnvelopeErrors = Schema.Struct({
	errors: Schema.optionalKey(Schema.NullOr(Schema.Array(EnvelopeError))),
})
const decodeEnvelopeErrors = Schema.decodeUnknownOption(Schema.fromJsonString(EnvelopeErrors))

const errorsOf = (body: string): ReadonlyArray<EnvelopeError> =>
	Option.getOrElse(
		Option.flatMap(decodeEnvelopeErrors(body), (envelope) => Option.fromNullishOr(envelope.errors)),
		(): ReadonlyArray<EnvelopeError> => [],
	)

/** Cloudflare puts auth and throttling codes inside a 200 or 400 envelope, not only a 401 or 429. */
const AUTH_CODES: ReadonlySet<number> = new Set([6003, 9103, 9106, 9109, 10000])
const THROTTLED_CODE = 971

const envelopeKind = (errors: ReadonlyArray<EnvelopeError>): VendorHttp.VendorFailureKind | undefined =>
	Arr.some(errors, (error) => error.code === THROTTLED_CODE)
		? "rate_limited"
		: Arr.some(
					errors,
					(error) => error.code !== undefined && error.code !== null && AUTH_CODES.has(error.code),
			  )
			? "unauthorized"
			: Arr.some(
						errors,
						(error) =>
							error.code === 10001 &&
							!/internal error|unable to authenticate request/i.test(error.message ?? ""),
				  )
				? "forbidden"
				: undefined

const envelopeDetail = (errors: ReadonlyArray<EnvelopeError>) =>
	Option.getOrUndefined(
		Arr.findFirst(errors, (error) =>
			error.message === undefined || error.message === null || error.message === ""
				? Option.none()
				: Option.some(error.message),
		),
	)

/**
 * Under load Cloudflare rejects valid tokens with "Authentication error" (10000) or a 10001
 * "Unable to authenticate request"; a genuinely bad token fails the same way after the retries.
 */
const isAuthBlip = (error: VendorHttp.VendorHttpError) =>
	Arr.some(
		errorsOf(error.body ?? ""),
		(entry) =>
			(entry.code === 10000 && /authentication error/i.test(entry.message ?? "")) ||
			(entry.code === 10001 &&
				/internal error|unable to authenticate request/i.test(entry.message ?? "")),
	)

const toCloudflareError = (error: VendorHttp.VendorHttpError): CloudflareApiError =>
	error.kind === "unauthorized" || error.kind === "forbidden"
		? new IntegrationsRevokedError({
				message: "Cloudflare rejected the access token; reconnect the integration",
			})
		: new IntegrationsUpstreamError({
				message: Str.slice(0, 500)(error.detail ?? error.message),
				...(error.status === undefined ? undefined : { status: error.status }),
				cause: error,
			})

const client = (httpClient: HttpClient.HttpClient, accessToken: string, apiBaseUrl: string | undefined) =>
	VendorHttp.make({
		httpClient,
		peerService: "cloudflare",
		// Overridable (CLOUDFLARE_API_BASE_URL) so local dev and tests can point at a mock.
		baseUrl: Str.replace(
			/\/$/,
			"",
		)(apiBaseUrl === undefined || apiBaseUrl === "" ? DEFAULT_API_BASE_URL : apiBaseUrl),
		auth: VendorHttp.bearer(accessToken),
		classify: (refusal) => envelopeKind(errorsOf(refusal.body)),
		detail: (body) => envelopeDetail(errorsOf(body)),
		toError: (error) => error,
		timeout: REQUEST_TIMEOUT,
	})

type CloudflareClient = ReturnType<typeof client>

/** A Cloudflare v4 envelope around `result`. A 2xx with `success: false` is still a failure. */
const Envelope = <S extends Schema.Top>(result: S) =>
	Schema.Struct({
		success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		errors: Schema.optionalKey(Schema.NullOr(Schema.Array(EnvelopeError))),
		// A failure envelope may carry no `result`; its errors still classify it.
		result: Schema.optionalKey(Schema.NullOr(result)),
		result_info: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
					per_page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
					total_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
					total_pages: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				}),
			),
		),
	})

const encodeEnvelopeErrors = Schema.encodeSync(Schema.fromJsonString(EnvelopeErrors))

const refusedEnvelope = (request: VendorHttp.VendorRequest, errors: ReadonlyArray<EnvelopeError>) => {
	const detail = envelopeDetail(errors)
	return new VendorHttp.VendorHttpError({
		// Kept as the body so `isAuthBlip` reads a 200 envelope's codes like a 400's.
		body: encodeEnvelopeErrors({ errors }),
		message: `cloudflare answered success: false${request.operation === undefined ? "" : ` while ${request.operation}`}`,
		kind: envelopeKind(errors) ?? "upstream",
		peerService: "cloudflare",
		...(request.operation === undefined ? undefined : { operation: request.operation }),
		...(detail === undefined ? undefined : { detail }),
	})
}

/** One read, retried on a transient failure and on an auth blip. */
const read = <S extends Schema.Top>(
	cloudflare: CloudflareClient,
	schema: S,
	request: VendorHttp.VendorRequest,
): Effect.Effect<S["Type"], VendorHttp.VendorHttpError, S["DecodingServices"]> =>
	cloudflare.json(schema, request).pipe(Effect.retry({ schedule: AUTH_BLIP_RETRY, while: isAuthBlip }))

/** The `result` of one REST call, failing a 2xx whose envelope says `success: false`. */
const restResult = <S extends Schema.Top>(
	cloudflare: CloudflareClient,
	result: S,
	request: VendorHttp.VendorRequest,
) =>
	cloudflare.json(Envelope(result), request).pipe(
		Effect.filterOrFail(
			(envelope) => envelope.success !== false,
			(envelope) => refusedEnvelope(request, envelope.errors ?? []),
		),
		// A success with no result must not read as an empty inventory that wipes the stored one.
		Effect.filterOrFail(
			(envelope) => envelope.result !== undefined && envelope.result !== null,
			() =>
				new VendorHttp.VendorHttpError({
					message: `cloudflare answered success with no result${request.operation === undefined ? "" : ` while ${request.operation}`}`,
					kind: "invalid_response",
					peerService: "cloudflare",
					...(request.operation === undefined ? undefined : { operation: request.operation }),
				}),
		),
		// Inside the retry, so a 200 auth blip is retried like a 400 one.
		Effect.retry({ schedule: AUTH_BLIP_RETRY, while: isAuthBlip }),
	)

/** Runs a call over the fetch client; tests replace `FetchHttpClient.Fetch`. */
const withClient = <A, R>(
	accessToken: string,
	apiBaseUrl: string | undefined,
	use: (cloudflare: CloudflareClient) => Effect.Effect<A, VendorHttp.VendorHttpError, R>,
): Effect.Effect<A, CloudflareApiError, R> =>
	Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
		use(client(httpClient, accessToken, apiBaseUrl)),
	).pipe(
		Effect.mapError(toCloudflareError),
		// Callers pass no client; the fetch client reads `FetchHttpClient.Fetch` at request time.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(FetchHttpClient.layer),
	)

/**
 * A bounded listing. `truncated` means the cap was hit and more items exist
 * upstream, so callers must not treat `items` as a complete inventory (no
 * disabling/deleting/filtering of resources that merely fell past the cap).
 */
export interface BoundedListing<T> {
	readonly items: ReadonlyArray<T>
	readonly truncated: boolean
}

/**
 * Page-mode listing, up to one item past `max` so truncation is observable. It stops on an empty
 * page, on `total_pages`, on a short page once `total_count` is reached, and when Cloudflare
 * answers a page other than the one asked for (an endpoint that ignores `page`).
 */
const listPages = <S extends Schema.Top>(
	cloudflare: CloudflareClient,
	item: S,
	request: (page: number) => VendorHttp.VendorRequest,
	max: number,
): Effect.Effect<BoundedListing<S["Type"]>, VendorHttp.VendorHttpError, S["DecodingServices"]> => {
	const bounded = (items: ReadonlyArray<S["Type"]>): BoundedListing<S["Type"]> => ({
		items: items.slice(0, max),
		truncated: items.length > max,
	})
	const page = (
		number: number,
		collected: ReadonlyArray<S["Type"]>,
	): Effect.Effect<BoundedListing<S["Type"]>, VendorHttp.VendorHttpError, S["DecodingServices"]> =>
		restResult(cloudflare, Schema.Array(item), request(number)).pipe(
			Effect.flatMap((envelope) => {
				const info = envelope.result_info ?? undefined
				if (number > 1 && typeof info?.page === "number" && info.page !== number) {
					// The endpoint ignored `page`: more exists upstream, so the listing is not complete.
					return Effect.succeed({ items: collected.slice(0, max), truncated: true })
				}
				const items = envelope.result ?? []
				const all = [...collected, ...items]
				const perPage = info?.per_page ?? PAGE_SIZE
				const lastPage =
					items.length === 0 ||
					(typeof info?.total_pages === "number" && number >= info.total_pages) ||
					// A short page is the last, unless the total says more exist (an endpoint that
					// ignores `page` answers short and would otherwise be re-read to the cap).
					(items.length < perPage &&
						(typeof info?.total_count !== "number" || all.length >= info.total_count))
				return lastPage || all.length > max ? Effect.succeed(bounded(all)) : page(number + 1, all)
			}),
		)
	return page(1, [])
}

export interface CloudflareAccount {
	readonly id: string
	readonly name: string
	readonly type: string
}

const Account = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String })

/**
 * List the Cloudflare accounts the token can access. Used by the OAuth `completeConnect` flow to resolve
 * (and enforce a single) account for the org.
 */
export const listAccounts: (
	accessToken: string,
	apiBaseUrl?: string,
) => Effect.Effect<ReadonlyArray<CloudflareAccount>, CloudflareApiError> = Effect.fn(
	"CloudflareApi.listAccounts",
)(function* (accessToken: string, apiBaseUrl?: string) {
	const response = yield* withClient(accessToken, apiBaseUrl, (cloudflare) =>
		restResult(cloudflare, Schema.Array(Account), {
			path: "/accounts",
			query: { per_page: String(PAGE_SIZE) },
			operation: "listing accounts",
		}),
	)
	const accounts = response.result ?? []
	yield* Effect.annotateCurrentSpan("maple.cloudflare.account_count", accounts.length)
	return Arr.map(accounts, (account) => ({ id: account.id, name: account.name, type: account.type }))
})

export interface CloudflareZone {
	readonly id: string
	readonly name: string
	readonly status: string | null
}

const Zone = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

// Zone discovery is bounded: the analytics poller reconciles state rows per zone, so a
// pathological account with thousands of zones must not fan out unbounded work.
const MAX_ZONES = 200

/**
 * List the account's active zones. Used by the analytics poller for zone discovery: each active
 * zone gets a poll-state row (and thus edge metrics under `cloudflare/{zoneName}`).
 */
export const listZones: (
	accessToken: string,
	accountId: string,
	apiBaseUrl?: string,
) => Effect.Effect<BoundedListing<CloudflareZone>, CloudflareApiError> = Effect.fn("CloudflareApi.listZones")(
	function* (accessToken: string, accountId: string, apiBaseUrl?: string) {
		yield* Effect.annotateCurrentSpan("maple.cloudflare.account_id", accountId)
		const zones = yield* withClient(accessToken, apiBaseUrl, (cloudflare) =>
			listPages(
				cloudflare,
				Zone,
				(page) => ({
					path: "/zones",
					query: {
						"account.id": accountId,
						status: "active",
						page: String(page),
						per_page: String(PAGE_SIZE),
					},
					operation: "listing zones",
				}),
				MAX_ZONES,
			),
		)
		yield* Effect.annotateCurrentSpan("maple.cloudflare.zone_count", zones.items.length)
		yield* Effect.annotateCurrentSpan("maple.cloudflare.zone_listing_truncated", zones.truncated)
		return {
			items: Arr.map(zones.items, (zone) => ({
				id: zone.id,
				name: zone.name,
				status: zone.status ?? null,
			})),
			truncated: zones.truncated,
		}
	},
)

// Script enumeration is bounded like zone discovery: the poller only needs a membership set to
// filter stale scriptName dimensions, so a pathological account can't fan out unbounded work.
const MAX_SCRIPTS = 1000

const Script = Schema.Struct({ id: Schema.optionalKey(Schema.NullOr(Schema.String)) })

/**
 * List the account's live Worker script names. Used by the analytics poller to drop GraphQL
 * invocation groups for deleted scripts (e.g. torn-down PR preview workers whose crons kept the
 * scriptName dimension alive), since GraphQL happily returns whatever ran in the window, deleted or not.
 */
export const listWorkerScripts: (
	accessToken: string,
	accountId: string,
	apiBaseUrl?: string,
) => Effect.Effect<BoundedListing<string>, CloudflareApiError> = Effect.fn("CloudflareApi.listWorkerScripts")(
	function* (accessToken: string, accountId: string, apiBaseUrl?: string) {
		yield* Effect.annotateCurrentSpan("maple.cloudflare.account_id", accountId)
		// Paged as the SDK paged it; ids are de-duplicated in case a page number is ignored.
		const scripts = yield* withClient(accessToken, apiBaseUrl, (cloudflare) =>
			listPages(
				cloudflare,
				Script,
				(page) => ({
					path: `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
					query: { page: String(page), per_page: String(PAGE_SIZE) },
					operation: "listing worker scripts",
				}),
				MAX_SCRIPTS,
			),
		)
		yield* Effect.annotateCurrentSpan("maple.cloudflare.script_count", scripts.items.length)
		yield* Effect.annotateCurrentSpan("maple.cloudflare.script_listing_truncated", scripts.truncated)
		return {
			items: Arr.dedupe(
				Arr.flatMap(scripts.items, (script) =>
					script.id === undefined || script.id === null || script.id === "" ? [] : [script.id],
				),
			),
			truncated: scripts.truncated,
		}
	},
)

export interface CloudflareHyperdriveConfig {
	readonly id: string
	readonly name: string
	readonly origin: {
		/** Null for the VPC-service origin variant, which has no public host. */
		readonly host: string | null
		/** Null for the Access-client and VPC origin variants. */
		readonly port: number | null
		readonly database: string
		readonly scheme: string
		readonly user: string | null
	}
}

// Config enumeration is bounded like zones/scripts: the map only needs the org's origin set,
// so a pathological account can't fan out unbounded work.
const MAX_HYPERDRIVE_CONFIGS = 200

/** The origin union (public, Access client, VPC service) has no discriminant; each arm is read by its fields. */
const HyperdriveConfig = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	origin: Schema.Struct({
		host: Schema.optionalKey(Schema.NullOr(Schema.String)),
		port: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		database: Schema.String,
		scheme: Schema.String,
		user: Schema.optionalKey(Schema.NullOr(Schema.String)),
		serviceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	}),
})

/**
 * List the account's Hyperdrive configs. Used by the analytics poller's discovery pass so the
 * service map can resolve what actually sits behind the collapsed Hyperdrive node (the origin
 * database, e.g. a PlanetScale database). The origin union is normalized to nullable host/port:
 * only a public origin has a port, and a VPC-service origin has no host.
 */
export const listHyperdriveConfigs: (
	accessToken: string,
	accountId: string,
	apiBaseUrl?: string,
) => Effect.Effect<BoundedListing<CloudflareHyperdriveConfig>, CloudflareApiError> = Effect.fn(
	"CloudflareApi.listHyperdriveConfigs",
)(function* (accessToken: string, accountId: string, apiBaseUrl?: string) {
	yield* Effect.annotateCurrentSpan("maple.cloudflare.account_id", accountId)
	const configs = yield* withClient(accessToken, apiBaseUrl, (cloudflare) =>
		listPages(
			cloudflare,
			HyperdriveConfig,
			(page) => ({
				path: `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`,
				query: { page: String(page) },
				operation: "listing hyperdrive configs",
			}),
			MAX_HYPERDRIVE_CONFIGS,
		),
	)
	yield* Effect.annotateCurrentSpan("maple.cloudflare.hyperdrive_config_count", configs.items.length)
	yield* Effect.annotateCurrentSpan("maple.cloudflare.hyperdrive_listing_truncated", configs.truncated)
	return {
		items: Arr.map(configs.items, (config): CloudflareHyperdriveConfig => {
			const { origin } = config
			const vpc = origin.serviceId !== undefined && origin.serviceId !== null
			return {
				id: config.id,
				name: config.name,
				origin: {
					host: vpc ? null : (origin.host ?? null),
					port: vpc ? null : (origin.port ?? null),
					database: origin.database,
					scheme: origin.scheme,
					user: origin.user ?? null,
				},
			}
		}),
		truncated: configs.truncated,
	}
})

const GraphqlErrorItem = Schema.Struct({
	message: Schema.String,
	// GraphQL error extensions carry Cloudflare's machine-readable code (e.g. "authz" for
	// permission failures); path points at the offending selection. Both optional/loose;
	// callers branch on message + code, never on the full shape.
	extensions: Schema.optionalKey(Schema.Unknown),
	path: Schema.optionalKey(Schema.Unknown),
})

const GraphqlResponse = Schema.Struct({
	data: Schema.optionalKey(Schema.Unknown),
	errors: Schema.optionalKey(Schema.Union([Schema.Array(GraphqlErrorItem), Schema.Null])),
})

export interface CloudflareGraphqlError {
	readonly message: string
	readonly extensions?: unknown
	readonly path?: unknown
}

/**
 * A GraphQL execution result. Transport/auth failures surface as {@link CloudflareApiError};
 * GraphQL-level errors (HTTP 200 + `errors[]`, e.g. a dataset the plan doesn't include) are
 * returned for the caller to interpret, since only it knows whether an error means "disable this
 * dataset" or "reconnect the integration".
 */
export interface CloudflareGraphqlResult {
	readonly data: unknown
	readonly errors: ReadonlyArray<CloudflareGraphqlError>
}

/** Execute a GraphQL Analytics API query (`POST {apiBaseUrl}/graphql`). A query only reads, so it is retried. */
export const graphqlQuery: (
	accessToken: string,
	request: { readonly query: string; readonly variables?: Record<string, unknown> },
	apiBaseUrl?: string,
) => Effect.Effect<CloudflareGraphqlResult, CloudflareApiError> = Effect.fn("CloudflareApi.graphqlQuery")(
	function* (
		accessToken: string,
		request: { readonly query: string; readonly variables?: Record<string, unknown> },
		apiBaseUrl?: string,
	) {
		const response = yield* withClient(accessToken, apiBaseUrl, (cloudflare) =>
			read(cloudflare, GraphqlResponse, {
				method: "POST",
				path: "/graphql",
				body: {
					query: request.query,
					...(request.variables === undefined ? undefined : { variables: request.variables }),
				},
				operation: "querying analytics",
				retry: true,
			}),
		)
		const errors = response.errors ?? []
		yield* Effect.annotateCurrentSpan("maple.cloudflare.graphql_error_count", errors.length)
		return { data: response.data ?? null, errors }
	},
)
