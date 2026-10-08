// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * The Google calls the poller makes, over WebCrypto and `fetch` so they run in a Worker. Nothing
 * here may leak a credential: tokens stay `Redacted`, and a failure carries the HTTP status and
 * Google's error code and reason only, never a response body, transport error or schema issue.
 * Untraced on purpose: the HTTP client records a span per request, and "not set up yet" is not an
 * exception.
 */
import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import {
	GCP_ASSET_TYPES,
	gcpMetricAligner,
	type GcpMetric,
	type GcpMetricGroup,
} from "@maple/domain/gcp-metrics"
import type { GcpConnectorId, GcpProjectId } from "@maple/domain/primitives"
import { Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
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

export class GcpApiError extends Schema.TaggedError<GcpApiError>()("@maple/api/integrations/GcpApiError", {
	message: Schema.String,
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
	return /^[A-Za-z_]{1,40}$/.test(code) ? ` ${code}` : ""
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

const errorReason = (body: unknown): string | undefined =>
	Option.toArray(decodeErrorDetails(body))
		.flatMap((decoded) => decoded.error.details)
		.flatMap((detail) => Option.toArray(decodeErrorInfo(detail)))[0]?.reason

/** One JSON call. `api` names the Google service in the error message. */
const call = <A>(
	httpClient: HttpClient.HttpClient,
	api: string,
	request: HttpClientRequest.HttpClientRequest,
	decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
): Effect.Effect<A, GcpApiError> => {
	const failed = (what: string) => () =>
		Effect.fail(new GcpApiError({ message: `${api} ${what}`, kind: "upstream" }))
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(request)
		const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
		if (response.status >= 300) {
			const reason = errorReason(body)
			return yield* new GcpApiError({
				message: `${api} returned ${response.status}${errorCode(body)}${reason === undefined ? "" : ` (${reason})`}`,
				kind: errorKind(response.status),
				...(reason === undefined ? undefined : { reason }),
			})
		}
		return yield* decode(body)
	}).pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTags({
			HttpClientError: failed("request failed"),
			TimeoutError: failed("request timed out"),
			SchemaError: failed("answered with an unexpected body"),
		}),
		Effect.annotateSpans("peer.service", "google-cloud"),
	)
}

// Maple's service account

const ServiceAccountKey = Schema.Struct({
	client_email: Schema.String,
	private_key: Schema.String,
	private_key_id: Schema.String,
})
const decodeServiceAccountKey = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceAccountKey))

const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64")
	return der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)
}

/** `MAPLE_GCP_SERVICE_ACCOUNT_KEY`: the service account's key file, base64-encoded. */
export const importServiceAccountKey = (encoded: Redacted.Redacted<string>) =>
	decodeServiceAccountKey(Buffer.from(Redacted.value(encoded), "base64").toString("utf8")).pipe(
		Effect.flatMap((key) =>
			Effect.tryPromise(() =>
				crypto.subtle.importKey(
					"pkcs8",
					pemToPkcs8(key.private_key),
					{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
					false,
					["sign"],
				),
			).pipe(
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
					kind: "invalid",
				}),
		),
	)

const base64Url = (value: string | ArrayBuffer) =>
	(typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)).toString("base64url")

const decodeAccessToken = Schema.decodeUnknownEffect(
	Schema.Struct({ access_token: Schema.RedactedFromValue(Schema.String) }),
)

/** Maple's own access token: an RS256-signed JWT exchanged at Google's OAuth endpoint. */
export const fetchMapleAccessToken = Effect.fnUntraced(function* (
	httpClient: HttpClient.HttpClient,
	signer: Effect.Success<ReturnType<typeof importServiceAccountKey>>,
	nowMs: number,
) {
	const issuedAt = Math.floor(nowMs / 1000)
	const signingInput = [
		{ alg: "RS256", typ: "JWT", kid: signer.keyId },
		{
			iss: signer.clientEmail,
			scope: IAM_SCOPE,
			aud: TOKEN_URL,
			iat: issuedAt,
			exp: issuedAt + TOKEN_LIFETIME_SECONDS,
		},
	]
		.map((part) => base64Url(JSON.stringify(part)))
		.join(".")
	const signature = yield* Effect.promise(() =>
		crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.key, new TextEncoder().encode(signingInput)),
	)
	const response = yield* call(
		httpClient,
		"Google OAuth",
		HttpClientRequest.post(TOKEN_URL).pipe(
			HttpClientRequest.bodyUrlParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: `${signingInput}.${base64Url(signature)}`,
			}),
		),
		decodeAccessToken,
	)
	return response.access_token
})

const decodeImpersonatedToken = Schema.decodeUnknownEffect(
	Schema.Struct({ accessToken: Schema.RedactedFromValue(Schema.String) }),
)

/** A connector's reader account, signed in. Its project pays the quota for what it reads. */
export interface GcpReader {
	readonly accessToken: Redacted.Redacted<string>
	readonly quotaProject: GcpProjectId
}

const asReader = (reader: GcpReader) => (request: HttpClientRequest.HttpClientRequest) =>
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
	mapleToken: Redacted.Redacted<string>,
	connector: { readonly id: GcpConnectorId; readonly projectId: GcpProjectId },
) {
	// A project id has nothing to encode; encoding keeps any other stored value inside the path.
	const account = `${gcpConnectorResourceNames(connector.id).serviceAccountId}@${encodeURIComponent(connector.projectId)}.iam.gserviceaccount.com`
	const response = yield* call(
		httpClient,
		"Google IAM",
		HttpClientRequest.post(
			`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
		).pipe(
			HttpClientRequest.bearerToken(mapleToken),
			HttpClientRequest.bodyJsonUnsafe({
				scope: [READER_SCOPE],
				lifetime: `${TOKEN_LIFETIME_SECONDS}s`,
			}),
		),
		decodeImpersonatedToken,
	).pipe(
		// Not made through the host project, so its reason says nothing about that project.
		Effect.mapError(({ message, kind }) => new GcpApiError({ message, kind })),
	)
	return { accessToken: response.accessToken, quotaProject: connector.projectId } satisfies GcpReader
})

// Cloud Monitoring

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

const decodeTimeSeriesPage = Schema.decodeUnknownEffect(
	Schema.Struct({
		timeSeries: Schema.optionalKey(Schema.Array(TimeSeries)),
		nextPageToken: Schema.optionalKey(Schema.String),
	}),
)

export interface GcpTimeSeriesQuery {
	/** `projects/<id>`, `folders/<number>` or `organizations/<number>`. */
	readonly scope: string
	readonly group: GcpMetricGroup
	readonly metric: GcpMetric
	readonly startMs: number
	readonly endMs: number
}

/**
 * One page of one metric type over `[startMs, endMs]` for everything in the scope, aligned to
 * 60 seconds and reduced to the project plus the labels the table keeps.
 */
export const listTimeSeriesPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	query: GcpTimeSeriesQuery,
	pageToken: string | undefined,
) =>
	call(
		httpClient,
		"Cloud Monitoring",
		HttpClientRequest.get(`https://monitoring.googleapis.com/v3/${query.scope}/timeSeries`).pipe(
			asReader(reader),
			HttpClientRequest.setUrlParams({
				filter: `metric.type = "${query.metric.type}" AND resource.type = "${query.group.resourceType}"`,
				"interval.startTime": new Date(query.startMs).toISOString(),
				"interval.endTime": new Date(query.endMs).toISOString(),
				"aggregation.alignmentPeriod": "60s",
				"aggregation.perSeriesAligner": gcpMetricAligner(query.metric),
				"aggregation.crossSeriesReducer": query.metric.reducer,
				"aggregation.groupByFields": [
					"resource.label.project_id",
					...query.group.resourceLabels.map((label) => `resource.label.${label}`),
					...query.metric.labels.map((label) => `metric.label.${label}`),
				],
				view: "FULL",
				pageSize: TIME_SERIES_PAGE_SIZE,
				pageToken,
			}),
		),
		decodeTimeSeriesPage,
	)

// Cloud Asset Inventory

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

const decodeResourcePage = Schema.decodeUnknownEffect(
	Schema.Struct({
		results: Schema.optionalKey(Schema.Array(ResourceSearchResult)),
		nextPageToken: Schema.optionalKey(Schema.String),
	}),
)

export const searchResourcesPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	scope: string,
	pageToken: string | undefined,
) =>
	call(
		httpClient,
		"Cloud Asset Inventory",
		HttpClientRequest.get(`https://cloudasset.googleapis.com/v1/${scope}:searchAllResources`).pipe(
			asReader(reader),
			HttpClientRequest.setUrlParams({
				assetTypes: GCP_ASSET_TYPES,
				readMask: Object.keys(ResourceSearchResult.fields).join(","),
				pageSize: RESOURCE_PAGE_SIZE,
				pageToken,
			}),
		),
		decodeResourcePage,
	)
