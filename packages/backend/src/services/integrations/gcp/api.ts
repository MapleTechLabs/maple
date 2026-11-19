// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
/**
 * The Google calls the poller makes, over WebCrypto and `fetch` so they run in a Worker. Nothing
 * here may leak a credential: tokens stay `Redacted`, and a failure carries the HTTP status and
 * Google's error code and reason only, never a response body, transport error or schema issue.
 * The one sentence of Google's that is read, to tell a missing billing account from a missing
 * role, chooses a reason and is dropped.
 * Untraced on purpose: each request gets its own Client span, and "not set up yet" is not an
 * exception. Monitoring, Cloud Asset and IAM go through `@distilled.cloud/gcp`; the OAuth token
 * exchange and BigQuery stay on plain HTTP (the SDK drops BigQuery's `error.errors[].reason`).
 */
import * as Gcp from "@distilled.cloud/gcp"
import * as CloudAsset from "@distilled.cloud/gcp/cloudasset_v1"
import * as IamCredentials from "@distilled.cloud/gcp/iamcredentials_v1"
import * as Monitoring from "@distilled.cloud/gcp/monitoring_v3"
import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import {
	GCP_ASSET_TYPES,
	gcpMetricAligner,
	type GcpMetric,
	type GcpMetricGroup,
} from "@maple/domain/gcp-metrics"
import type { GcpConnectorId, GcpProjectId } from "@maple/primitives"
import {
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
	Schema,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { type HttpClient, HttpClientRequest } from "effect/http"
import { pemToPkcs8, RS256, signJwt } from "@maple/backend/platform/jwt"
import * as VendorHttp from "../vendor-http"
import * as VendorSdk from "../vendor-sdk"

const OAUTH_URL = "https://oauth2.googleapis.com"
const TOKEN_URL = `${OAUTH_URL}/token`
const IAM_SCOPE = "https://www.googleapis.com/auth/iam"
// Cloud Asset Inventory accepts no narrower scope. What the token can do is bounded by the
// reader account's roles, which the setup script keeps to read-only viewers.
const READER_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const TOKEN_LIFETIME_SECONDS = 600
const REQUEST_TIMEOUT = Duration.seconds(20)
/**
 * Points per `timeSeries.list` page: about 0.3 MB of JSON, 1 MB for distributions, so three
 * connectors decoding a page each stay far below the Worker's 128 MB.
 */
const TIME_SERIES_PAGE_SIZE = 2_000
export const RESOURCE_PAGE_SIZE = 500

/** The Google APIs the poller calls, as a connection's error text names them. */
const GcpApi = Schema.Literals([
	"Google OAuth",
	"IAM Credentials",
	"Cloud Monitoring",
	"Cloud Asset Inventory",
	"BigQuery",
])

export class GcpApiError extends Schema.TaggedError<GcpApiError>()("@maple/api/integrations/GcpApiError", {
	message: Schema.String,
	api: GcpApi,
	/**
	 * `denied`: 401/403. `not_found`: 404. `rate_limited`: 429. `invalid`: any other 4xx.
	 * `upstream`: 5xx, transport, timeout or an undecodable body.
	 */
	kind: Schema.Literals(["denied", "not_found", "rate_limited", "invalid", "upstream"]),
	/**
	 * Why Google refused a call made through the host project, where its answer says so:
	 * `SERVICE_DISABLED`, `BILLING_DISABLED`, ...
	 */
	reason: Schema.optionalKey(Schema.String),
}) {}

const errorKind = (status: number): GcpApiError["kind"] =>
	status === 401 || status === 403
		? "denied"
		: status === 404
			? "not_found"
			: status === 429
				? "rate_limited"
				: status < 500
					? "invalid"
					: "upstream"

const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// Google APIs answer `{ error: { status: "PERMISSION_DENIED" } }`, the OAuth endpoint
// `{ error: "invalid_grant" }`. Only a value that reads like one of those codes is kept.
const decodeErrorCode = Schema.decodeUnknownOption(
	Schema.Struct({
		error: Schema.Union([Schema.String, Schema.Struct({ status: Schema.String })]),
	}),
)

const errorCode = (body: unknown): string => {
	const decoded = decodeErrorCode(body)
	if (Option.isNone(decoded)) return ""
	const error = decoded.value.error
	const code = typeof error === "string" ? error : error.status
	return /^[A-Za-z_]{1,40}$/.test(code) ? code : ""
}

// A refusal can name its cause in `error.details`, as a `google.rpc.ErrorInfo` whose `reason` is
// UPPER_SNAKE_CASE and 63 characters at most. Nothing else of the details is kept.
const decodeErrorDetails = Schema.decodeUnknownOption(
	Schema.Struct({ error: Schema.Struct({ details: Schema.Array(Schema.Unknown) }) }),
)
const decodeErrorInfo = Schema.decodeUnknownOption(
	Schema.Struct({
		"@type": Schema.Literal("type.googleapis.com/google.rpc.ErrorInfo"),
		reason: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{1,61}[A-Z0-9]$/)),
	}),
)

// BigQuery names why it refused a call in the older `error.errors[].reason` (`rateLimitExceeded`,
// `quotaExceeded`, `billingNotEnabled`), on a 403 that otherwise reads like a missing role.
const decodeLegacyReasons = Schema.decodeUnknownOption(
	Schema.Struct({
		error: Schema.Struct({ errors: Schema.Array(Schema.Struct({ reason: Schema.String })) }),
	}),
)

const legacyReason = (body: unknown): string => {
	const reasons = Arr.map(
		Arr.flatMap(Option.toArray(decodeLegacyReasons(body)), (decoded) => decoded.error.errors),
		(error) => error.reason,
	)
	if (Arr.contains(reasons, "rateLimitExceeded") || Arr.contains(reasons, "quotaExceeded")) {
		return "RATE_LIMIT_EXCEEDED"
	}
	return Arr.contains(reasons, "billingNotEnabled") ? "BILLING_DISABLED" : ""
}

const decodeErrorMessage = Schema.decodeUnknownOption(
	Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
)

// Cloud Monitoring refuses a project without billing with a bare 403: no `ErrorInfo`, only a
// sentence. Its wording is the one thing that tells that refusal from a missing role.
const reasonFromMessage = (body: unknown): string => {
	const message = Option.getOrUndefined(decodeErrorMessage(body))?.error.message
	if (message === undefined) return ""
	if (Str.includes("requires billing")(message)) return "BILLING_DISABLED"
	// BigQuery refuses a query over `maximumBytesBilled` with a bare 400.
	if (Str.includes("exceeded limit for bytes billed")(message)) return "BYTES_BILLED_LIMIT_EXCEEDED"
	return Str.includes("has not been used")(message) || Str.includes("is disabled")(message)
		? "SERVICE_DISABLED"
		: ""
}

const errorInfoReason = (body: unknown): string =>
	Arr.flatMap(
		Arr.flatMap(Option.toArray(decodeErrorDetails(body)), (decoded) => decoded.error.details),
		(detail) => Option.toArray(decodeErrorInfo(detail)),
	)[0]?.reason ?? ""

/**
 * What a refusal's parsed body says, kept as `code|ErrorInfo reason|reason read from the message`:
 * each part a short code with no `|`. The body itself is dropped with the error.
 */
const googleDetailOf = (parsed: unknown) => {
	const fromMessage = reasonFromMessage(parsed)
	return `${errorCode(parsed)}|${errorInfoReason(parsed)}|${fromMessage === "" ? legacyReason(parsed) : fromMessage}`
}

const googleDetail = (body: string) => googleDetailOf(Option.getOrNull(decodeJsonBody(body)))

// The SDK keeps the envelope's gRPC `status` (or `code` on an unmapped status), `message` and
// `details`; the same reading applies to them as to a whole body.
const decodeSdkRefusal = Schema.decodeUnknownOption(
	Schema.Struct({
		status: Schema.optionalKey(Schema.Unknown),
		code: Schema.optionalKey(Schema.Unknown),
		message: Schema.optionalKey(Schema.Unknown),
		details: Schema.optionalKey(Schema.Unknown),
	}),
)

const sdkGoogleDetail = (error: VendorSdk.SdkFailure) =>
	Option.match(decodeSdkRefusal(error), {
		onNone: () => "||",
		onSome: (refusal) =>
			googleDetailOf({
				error: {
					status: typeof refusal.status === "string" ? refusal.status : refusal.code,
					message: refusal.message,
					details: refusal.details,
				},
			}),
	})

/** A failed call as the poller sees it: Google's status, code and reason, never the body. */
const toGcpApiError =
	(api: GcpApiError["api"]) =>
	(error: VendorHttp.VendorHttpError): GcpApiError => {
		if (error.status === undefined) {
			const what =
				error.kind === "timeout"
					? "request timed out"
					: error.kind === "invalid_response"
						? "answered with an unexpected body"
						: "request failed"
			return new GcpApiError({ message: `${api} ${what}`, api, kind: "upstream" })
		}
		const kind = errorKind(error.status)
		const [code, infoReason = "", messageReason = ""] = Str.split("|")(error.detail ?? "")
		const reason =
			infoReason !== ""
				? infoReason
				: (kind === "denied" || messageReason === "BYTES_BILLED_LIMIT_EXCEEDED") &&
					  messageReason !== ""
					? messageReason
					: undefined
		return new GcpApiError({
			message: `${api} returned ${error.status}${code === "" ? "" : ` ${code}`}${reason === undefined ? "" : `, ${reason}`}`,
			api,
			kind,
			...(reason === undefined ? undefined : { reason }),
		})
	}

/**
 * One Google API. A failed GET is tried once more at once; a 429 is never waited out, since the
 * tick's call budget is better spent on other connectors.
 */
export const google = (
	httpClient: HttpClient.HttpClient,
	api: GcpApiError["api"],
	baseUrl: string,
	auth: VendorHttp.VendorAuth,
) =>
	VendorHttp.make({
		httpClient,
		peerService: "google-cloud",
		baseUrl,
		auth,
		toError: toGcpApiError(api),
		detail: googleDetail,
		timeout: REQUEST_TIMEOUT,
		retry: Schedule.recurs(1),
		// A page that does not decode is read once more, as before the kit.
		retryInvalidResponse: true,
		maxRetryAfter: Duration.zero,
	})

const STATUS_BY_TAG = Rec.fromEntries(
	Arr.map(Rec.toEntries(Gcp.HTTP_STATUS_MAP), ([status, error]) => [error.name, Number(status)]),
)

/** One Google API through the SDK, under the same rules as {@link google}. */
const googleSdk = (
	httpClient: HttpClient.HttpClient,
	api: GcpApiError["api"],
	credentials: { readonly accessToken: Redacted.Redacted; readonly quotaProject?: string },
) =>
	VendorSdk.make({
		httpClient,
		peerService: "google-cloud",
		sdk: Layer.mergeAll(
			Layer.succeed(Gcp.Credentials, Effect.succeed(credentials)),
			Layer.succeed(Gcp.Retry.Retry, { while: () => false }),
		),
		statusByTag: STATUS_BY_TAG,
		toError: toGcpApiError(api),
		detail: sdkGoogleDetail,
		timeout: REQUEST_TIMEOUT,
		retry: Schedule.recurs(1),
		retryInvalidResponse: true,
		maxRetryAfter: Duration.zero,
	})

/** The reader's token, its project paying the quota (`x-goog-user-project`). */
const readerCredentials = (reader: GcpReader) => ({
	accessToken: reader.accessToken,
	quotaProject: reader.quotaProject,
})

const ServiceAccountKey = Schema.Struct({
	client_email: Schema.String,
	private_key: Schema.String,
	private_key_id: Schema.String,
})
const decodeServiceAccountKey = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceAccountKey))

/** `MAPLE_GCP_SERVICE_ACCOUNT_KEY`: the service account's key file, base64-encoded. */
export const importServiceAccountKey = (encoded: Redacted.Redacted) =>
	decodeServiceAccountKey(Buffer.from(Redacted.value(encoded), "base64").toString("utf8")).pipe(
		Effect.flatMap((key) =>
			Effect.tryPromise({
				try: () =>
					crypto.subtle.importKey("pkcs8", pemToPkcs8(key.private_key), RS256, false, ["sign"]),
				catch: () =>
					new GcpApiError({
						message: "MAPLE_GCP_SERVICE_ACCOUNT_KEY holds a private key that does not import",
						api: "Google OAuth",
						kind: "invalid",
					}),
			}).pipe(
				Effect.map((signingKey) => ({
					clientEmail: key.client_email,
					keyId: key.private_key_id,
					key: signingKey,
				})),
			),
		),
		Effect.mapError(
			() =>
				new GcpApiError({
					message: "MAPLE_GCP_SERVICE_ACCOUNT_KEY is not a base64-encoded service account key",
					api: "Google OAuth",
					kind: "invalid",
				}),
		),
	)

const AccessToken = Schema.Struct({ access_token: Schema.RedactedFromValue(Schema.String) })

/** Maple's own access token: an RS256-signed JWT exchanged at Google's OAuth endpoint. */
export const fetchMapleAccessToken = Effect.fnUntraced(function* (
	httpClient: HttpClient.HttpClient,
	signer: Effect.Success<ReturnType<typeof importServiceAccountKey>>,
	nowMs: number,
) {
	const issuedAt = Math.floor(nowMs / 1000)
	const assertion = yield* signJwt(
		signer.key,
		RS256,
		{ alg: "RS256", typ: "JWT", kid: signer.keyId },
		{
			iss: signer.clientEmail,
			scope: IAM_SCOPE,
			aud: TOKEN_URL,
			iat: issuedAt,
			exp: issuedAt + TOKEN_LIFETIME_SECONDS,
		},
	).pipe(
		Effect.mapError(
			() =>
				new GcpApiError({
					message: "Signing Maple's Google OAuth assertion failed",
					api: "Google OAuth",
					kind: "invalid",
				}),
		),
	)
	const response = yield* google(httpClient, "Google OAuth", OAUTH_URL, VendorHttp.noAuth).json(
		AccessToken,
		{
			method: "POST",
			path: "/token",
			form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion },
			operation: "signing in",
		},
	)
	return response.access_token
})

const ImpersonatedToken = Schema.Struct({ accessToken: Schema.RedactedFromValue(Schema.String) })

/** A connector's reader account, signed in. Its project pays the quota for what it reads. */
export interface GcpReader {
	readonly accessToken: Redacted.Redacted
	readonly quotaProject: GcpProjectId
}

export const asReader =
	(reader: GcpReader): VendorHttp.VendorAuth =>
	(request) =>
		request.pipe(
			HttpClientRequest.bearerToken(reader.accessToken),
			HttpClientRequest.setHeader("x-goog-user-project", reader.quotaProject),
		)

/**
 * A short-lived token for one connector's reader account: the service account the setup script
 * created in the connector's project. The account is derived from the connector here, so no
 * caller can name another organization's account.
 */
export const impersonateReader = Effect.fnUntraced(function* (
	httpClient: HttpClient.HttpClient,
	mapleToken: Redacted.Redacted,
	connector: { readonly id: GcpConnectorId; readonly projectId: GcpProjectId },
) {
	// A project id has nothing to encode; encoding keeps any other stored value inside the path.
	const account = `${gcpConnectorResourceNames(connector.id).serviceAccountId}@${encodeURIComponent(connector.projectId)}.iam.gserviceaccount.com`
	const response = yield* googleSdk(httpClient, "IAM Credentials", { accessToken: mapleToken })
		.call(
			ImpersonatedToken,
			IamCredentials.generateAccessTokenProjectsServiceAccounts({
				name: `projects/-/serviceAccounts/${account}`,
				body: { scope: [READER_SCOPE], lifetime: `${TOKEN_LIFETIME_SECONDS}s` },
			}),
			{ method: "POST", operation: "impersonating the reader" },
		)
		.pipe(
			// Not made through the host project, so its reason says nothing about that project.
			Effect.mapError(({ message, api, kind }) => new GcpApiError({ message, api, kind })),
		)
	return { accessToken: response.accessToken, quotaProject: connector.projectId } satisfies GcpReader
})

const BucketOptions = Schema.Struct({
	linearBuckets: Schema.optionalKey(
		Schema.Struct({
			numFiniteBuckets: Schema.Number,
			width: Schema.Number,
			offset: Schema.optionalKey(Schema.Number),
		}),
	),
	exponentialBuckets: Schema.optionalKey(
		Schema.Struct({
			numFiniteBuckets: Schema.Number,
			growthFactor: Schema.Number,
			scale: Schema.Number,
		}),
	),
	explicitBuckets: Schema.optionalKey(
		Schema.Struct({ bounds: Schema.optionalKey(Schema.Array(Schema.Number)) }),
	),
})

const TimeSeries = Schema.Struct({
	metric: Schema.Struct({ labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
	resource: Schema.Struct({ labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
	points: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				interval: Schema.Struct({ endTime: Schema.String }),
				// int64 values arrive as strings, and zero-valued fields are omitted.
				value: Schema.Struct({
					doubleValue: Schema.optionalKey(Schema.Number),
					int64Value: Schema.optionalKey(Schema.String),
					distributionValue: Schema.optionalKey(
						Schema.Struct({
							count: Schema.optionalKey(Schema.String),
							bucketOptions: Schema.optionalKey(BucketOptions),
							bucketCounts: Schema.optionalKey(Schema.Array(Schema.String)),
						}),
					),
				}),
			}),
		),
	),
})
export type GcpTimeSeries = typeof TimeSeries.Type
export type GcpBucketOptions = typeof BucketOptions.Type

const TimeSeriesPage = Schema.Struct({
	timeSeries: Schema.optionalKey(Schema.Array(TimeSeries)),
	nextPageToken: Schema.optionalKey(Schema.String),
})

export interface GcpTimeSeriesQuery {
	/** `projects/<id>`, `folders/<number>` or `organizations/<number>`. */
	readonly scope: string
	readonly group: GcpMetricGroup
	readonly metric: GcpMetric
	readonly startMs: number
	readonly endMs: number
}

/** A point per minute; a top group's one point covers the whole window. */
export const gcpAlignmentMs = (query: Pick<GcpTimeSeriesQuery, "group" | "startMs" | "endMs">) =>
	query.group.top === undefined ? 60_000 : query.endMs - query.startMs

/**
 * One page of one metric type over `[startMs, endMs]` for everything in the scope, aligned per
 * `gcpAlignmentMs` and reduced to the project plus the labels the table keeps.
 */
/** The `timeSeries.list` operation of a scope's kind; all three send the same request. */
const listTimeSeriesOf = (scope: string) =>
	Str.startsWith("folders/")(scope)
		? Monitoring.listFoldersTimeSeries
		: Str.startsWith("organizations/")(scope)
			? Monitoring.listOrganizationsTimeSeries
			: Monitoring.listProjectsTimeSeries

export const listTimeSeriesPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	query: GcpTimeSeriesQuery,
	pageToken: string | undefined,
) =>
	googleSdk(httpClient, "Cloud Monitoring", readerCredentials(reader)).call(
		TimeSeriesPage,
		listTimeSeriesOf(query.scope)({
			name: query.scope,
			filter: `metric.type = "${query.metric.type}" AND resource.type = "${query.group.resourceType}"`,
			"interval.startTime": new Date(query.startMs).toISOString(),
			"interval.endTime": new Date(query.endMs).toISOString(),
			"aggregation.alignmentPeriod": `${gcpAlignmentMs(query) / 1000}s`,
			"aggregation.perSeriesAligner": gcpMetricAligner(query.metric),
			"aggregation.crossSeriesReducer": query.metric.reducer,
			"aggregation.groupByFields": [
				"resource.label.project_id",
				...Arr.map(query.group.resourceLabels, (label) => `resource.label.${label}`),
				...Arr.map(
					[...query.group.resourceMetricLabels, ...query.metric.labels],
					(label) => `metric.label.${label}`,
				),
			],
			view: "FULL",
			pageSize: TIME_SERIES_PAGE_SIZE,
			...(pageToken === undefined ? undefined : { pageToken }),
		}),
		{ operation: "reading metrics" },
	)

const ResourceSearchResult = Schema.Struct({
	/** Full resource name, e.g. `//run.googleapis.com/projects/p/locations/l/services/s`. */
	name: Schema.String,
	assetType: Schema.String,
	displayName: Schema.optionalKey(Schema.String),
	location: Schema.optionalKey(Schema.String),
	state: Schema.optionalKey(Schema.String),
	labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	createTime: Schema.optionalKey(Schema.String),
	updateTime: Schema.optionalKey(Schema.String),
	/** For a project it carries `projectId`. */
	additionalAttributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type GcpResourceSearchResult = typeof ResourceSearchResult.Type

const ResourcePage = Schema.Struct({
	results: Schema.optionalKey(Schema.Array(ResourceSearchResult)),
	nextPageToken: Schema.optionalKey(Schema.String),
})

const cloudAsset = (httpClient: HttpClient.HttpClient, reader: GcpReader) =>
	googleSdk(httpClient, "Cloud Asset Inventory", readerCredentials(reader))

export const searchResourcesPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	scope: string,
	pageToken: string | undefined,
) =>
	cloudAsset(httpClient, reader).call(
		ResourcePage,
		CloudAsset.searchAllResourcesV1({
			scope,
			assetTypes: [...GCP_ASSET_TYPES],
			readMask: Arr.join(Rec.keys(ResourceSearchResult.fields), ","),
			pageSize: RESOURCE_PAGE_SIZE,
			...(pageToken === undefined ? undefined : { pageToken }),
		}),
		{ operation: "listing resources" },
	)

/** What Maple reads of a Cloud SQL instance: the Cloud SQL Admin API's `DatabaseInstance`. */
const SqlInstanceData = Schema.Struct({
	name: Schema.String,
	project: Schema.String,
	region: Schema.optionalKey(Schema.String),
	databaseVersion: Schema.optionalKey(Schema.String),
	/** `project:instance`. */
	masterInstanceName: Schema.optionalKey(Schema.String),
	settings: Schema.optionalKey(
		Schema.Struct({
			tier: Schema.optionalKey(Schema.String),
			edition: Schema.optionalKey(Schema.String),
			availabilityType: Schema.optionalKey(Schema.String),
			// int64, as a string.
			dataDiskSizeGb: Schema.optionalKey(Schema.String),
			databaseFlags: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({ name: Schema.String, value: Schema.optionalKey(Schema.String) }),
				),
			),
			insightsConfig: Schema.optionalKey(
				Schema.Struct({ queryInsightsEnabled: Schema.optionalKey(Schema.Boolean) }),
			),
		}),
	),
})
export type GcpSqlInstanceData = typeof SqlInstanceData.Type

const SqlInstancePage = Schema.Struct({
	assets: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				/** The full resource name, as the search answers it. */
				name: Schema.String,
				resource: Schema.optionalKey(Schema.Struct({ data: Schema.optionalKey(SqlInstanceData) })),
			}),
		),
	),
	nextPageToken: Schema.optionalKey(Schema.String),
})

/**
 * One page of the Cloud SQL instances in a scope with their settings, for the inventory sync:
 * `assets.list` answers the resource itself, which search does not. Cloud Asset Viewer holds the
 * permission.
 */
export const listSqlInstancesPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	scope: string,
	pageToken: string | undefined,
) =>
	cloudAsset(httpClient, reader).call(
		SqlInstancePage,
		CloudAsset.listAssets({
			parent: scope,
			assetTypes: ["sqladmin.googleapis.com/Instance"],
			contentType: "RESOURCE",
			pageSize: RESOURCE_PAGE_SIZE,
			...(pageToken === undefined ? undefined : { pageToken }),
		}),
		{ operation: "listing Cloud SQL instances" },
	)
