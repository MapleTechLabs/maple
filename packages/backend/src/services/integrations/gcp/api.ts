// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * The Google calls the poller makes, over WebCrypto and `fetch` so they run in a Worker. Nothing
 * here may leak a credential: tokens stay `Redacted`, and a failure carries the HTTP status and
 * Google's error code and reason only, never a response body, transport error or schema issue.
 * The one sentence of Google's that is read, to tell a missing billing account from a missing
 * role, chooses a reason and is dropped. The exception is PromQL: Google's explanation of why
 * the caller's own query was refused or did not finish is passed on.
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
import { GcpMetricDescriptor, type GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import { GcpLiveQueryRejectedError } from "@maple/domain/http/gcp-live-query-errors"
import type { GcpConnectorId, GcpProjectId } from "@maple/domain/primitives"
import { Duration, Effect, Option, Redacted, Schema, Stream } from "effect"
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

/** The Google APIs the poller calls, as a connection's error text names them. */
const GcpApi = Schema.Literals([
	"Google OAuth",
	"IAM Credentials",
	"Cloud Monitoring",
	"Cloud Asset Inventory",
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

const decodeErrorMessage = Schema.decodeUnknownOption(
	Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
)

// Cloud Monitoring refuses a project without billing with a bare 403: no `ErrorInfo`, only a
// sentence. Its wording is the one thing that tells that refusal from a missing role.
const reasonFromMessage = (body: unknown): string | undefined => {
	const message = Option.getOrUndefined(decodeErrorMessage(body))?.error.message
	if (message === undefined) return undefined
	if (message.includes("requires billing")) return "BILLING_DISABLED"
	return message.includes("has not been used") || message.includes("is disabled")
		? "SERVICE_DISABLED"
		: undefined
}

const errorReason = (body: unknown, kind: GcpApiError["kind"]): string | undefined =>
	Option.toArray(decodeErrorDetails(body))
		.flatMap((decoded) => decoded.error.details)
		.flatMap((detail) => Option.toArray(decodeErrorInfo(detail)))[0]?.reason ??
	(kind === "denied" ? reasonFromMessage(body) : undefined)

/**
 * The largest answer a live query reads: four in flight stay far below the Worker's 128 MB.
 * The poller's calls are not capped.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

interface CallOptions<E> {
	/** Turns a failed answer into the caller's own error. */
	readonly refuse?: (status: number, body: unknown) => E | undefined
	/** Reads at most this many bytes of the answer (default: all of it). */
	readonly maxBytes?: number
	/** The caller's error for an answer past `maxBytes`. */
	readonly tooLarge?: () => E
}

/** One JSON call. `api` names the Google service in the error. */
const call = <A, E = never>(
	httpClient: HttpClient.HttpClient,
	api: GcpApiError["api"],
	request: HttpClientRequest.HttpClientRequest,
	decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
	options: CallOptions<E> = {},
): Effect.Effect<A, GcpApiError | E> => {
	const failed = (what: string) => new GcpApiError({ message: `${api} ${what}`, api, kind: "upstream" })
	const maxBytes = options.maxBytes ?? Infinity
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(request)
		// Read as it arrives, never trusting Content-Length: past the cap the rest is left unread.
		const chunks: Array<Uint8Array> = []
		let size = 0
		yield* Stream.runForEachWhile(response.stream, (chunk) =>
			Effect.sync(() => {
				size += chunk.byteLength
				if (size > maxBytes) return false
				chunks.push(chunk)
				return true
			}),
		)
		const overflow = size > maxBytes
		// A non-JSON body (an HTML error page) is no body, never an overflow.
		const body = overflow ? null : Option.getOrNull(parseJson(Buffer.concat(chunks).toString("utf8")))
		return { status: response.status, body, overflow }
	}).pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTags({
			HttpClientError: () => Effect.fail(failed("request failed")),
			TimeoutError: () => Effect.fail(failed("request timed out")),
		}),
		Effect.flatMap(({ status, body, overflow }) =>
			Effect.gen(function* () {
				if (status >= 300) {
					const refused = options.refuse?.(status, body)
					if (refused !== undefined) return yield* Effect.fail(refused)
					const kind = errorKind(status)
					const reason = errorReason(body, kind)
					return yield* new GcpApiError({
						message: `${api} returned ${status}${errorCode(body)}${reason === undefined ? "" : `, ${reason}`}`,
						api,
						kind,
						...(reason === undefined ? undefined : { reason }),
					})
				}
				if (overflow) {
					return yield* Effect.fail(
						options.tooLarge?.() ??
							failed(`answered with more than ${maxBytes / 1024 / 1024} MB`),
					)
				}
				return yield* decode(body).pipe(
					Effect.mapError(() => failed("answered with an unexpected body")),
				)
			}),
		),
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
					api: "Google OAuth",
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

const MAPLE_SIDE_REASONS = new Set(["SERVICE_DISABLED", "BILLING_DISABLED", "USER_PROJECT_DENIED"])

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
		"IAM Credentials",
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
		// Not made through the host project, so its reason says nothing about that project: a
		// refusal for Maple's own (API off, no billing, no quota grant) is Maple's to fix.
		Effect.mapError(
			({ message, api, kind, reason }) =>
				new GcpApiError({
					message,
					api,
					kind: reason !== undefined && MAPLE_SIDE_REASONS.has(reason) ? "upstream" : kind,
				}),
		),
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

/** A point per minute; a top group's one point covers the whole window. */
export const gcpAlignmentMs = (query: Pick<GcpTimeSeriesQuery, "group" | "startMs" | "endMs">) =>
	query.group.top === undefined ? 60_000 : query.endMs - query.startMs

/**
 * One page of one metric type over `[startMs, endMs]` for everything in the scope, aligned per
 * `gcpAlignmentMs` and reduced to the project plus the labels the table keeps.
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
				"aggregation.alignmentPeriod": `${gcpAlignmentMs(query) / 1000}s`,
				"aggregation.perSeriesAligner": gcpMetricAligner(query.metric),
				"aggregation.crossSeriesReducer": query.metric.reducer,
				"aggregation.groupByFields": [
					"resource.label.project_id",
					...query.group.resourceLabels.map((label) => `resource.label.${label}`),
					...[...query.group.resourceMetricLabels, ...query.metric.labels].map(
						(label) => `metric.label.${label}`,
					),
				],
				view: "FULL",
				pageSize: TIME_SERIES_PAGE_SIZE,
				pageToken,
			}),
		),
		decodeTimeSeriesPage,
	)

// Cloud Monitoring PromQL

/** Google's own limit is 120 s; this one answers before `REQUEST_TIMEOUT` gives up. */
const PROMQL_TIMEOUT = "18s"

const Labels = Schema.Record(Schema.String, Schema.String)
/** Prometheus sends values as strings: `"1.5"`, `"NaN"`, `"+Inf"`. */
const Sample = Schema.Tuple([Schema.Number, Schema.String])

const decodePromQlResult = Schema.decodeUnknownEffect(
	Schema.Struct({
		data: Schema.Union([
			Schema.Struct({
				resultType: Schema.Literal("matrix"),
				result: Schema.Array(Schema.Struct({ metric: Labels, values: Schema.Array(Sample) })),
			}),
			Schema.Struct({
				resultType: Schema.Literal("vector"),
				result: Schema.Array(Schema.Struct({ metric: Labels, value: Sample })),
			}),
		]),
	}),
)

const toPoints = (samples: ReadonlyArray<typeof Sample.Type>): Array<readonly [number, number]> =>
	samples.flatMap(([time, raw]) => {
		const value = Number(raw)
		return Number.isFinite(value) ? [[time, value] as const] : []
	})

const decodePromQlError = Schema.decodeUnknownOption(
	Schema.Struct({ status: Schema.Literal("error"), errorType: Schema.String, error: Schema.String }),
)

/**
 * Google's own error for a query: 400 `bad_data` refuses the query itself. 422 `execution` and
 * 503 `timeout` (too many samples, out of time) are the project's alone and stay a
 * `GcpApiError`, carrying Google's text.
 */
const refuseQuery = (status: number, body: unknown) =>
	Option.match(decodePromQlError(body), {
		onNone: () => undefined,
		onSome: ({ errorType, error }) =>
			status === 400
				? new GcpLiveQueryRejectedError({ message: error.slice(0, 1_000), reason: "invalid_query" })
				: status === 422 || status === 503
					? new GcpApiError({
							message: `Cloud Monitoring returned ${status} ${errorType}: ${error.slice(0, 500)}`,
							api: "Cloud Monitoring",
							kind: status === 422 ? "invalid" : "upstream",
							reason: "QUERY_EXECUTION",
						})
					: undefined,
	})

export type GcpPromQlParams =
	| { readonly query: string; readonly time: number }
	| { readonly query: string; readonly start: number; readonly end: number; readonly step: number }

/** One instant or range query against one project, times in epoch seconds. */
export const promQlQuery = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	projectId: GcpProjectId,
	params: GcpPromQlParams,
): Effect.Effect<ReadonlyArray<GcpPromQlSeries>, GcpApiError | GcpLiveQueryRejectedError> =>
	call(
		httpClient,
		"Cloud Monitoring",
		// A form body: a 4,000-character query would make a long URL.
		HttpClientRequest.post(
			`https://monitoring.googleapis.com/v1/projects/${projectId}/location/global/prometheus/api/v1/${"time" in params ? "query" : "query_range"}`,
		).pipe(asReader(reader), HttpClientRequest.bodyUrlParams({ ...params, timeout: PROMQL_TIMEOUT })),
		decodePromQlResult,
		{
			refuse: refuseQuery,
			maxBytes: MAX_BODY_BYTES,
			tooLarge: () =>
				new GcpLiveQueryRejectedError({
					message: `Google's answer for project ${projectId} is larger than 8 MB: too many series or points. Narrow the query or group by fewer labels.`,
					reason: "too_many_series",
				}),
		},
	).pipe(
		Effect.map(({ data }) =>
			data.resultType === "matrix"
				? data.result.map((series): GcpPromQlSeries => ({
						labels: series.metric,
						points: toPoints(series.values),
					}))
				: data.result.map((series): GcpPromQlSeries => ({
						labels: series.metric,
						points: toPoints([series.value]),
					})),
		),
	)

const decodeMetricsScope = Schema.decodeUnknownEffect(
	Schema.Struct({
		name: Schema.String,
		monitoredProjects: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
	}),
)

const lastSegment = (name: string) => name.slice(name.lastIndexOf("/") + 1)

/** A project's metrics scope: its number, and the numbers of the projects it reads, itself included. */
export const MetricsScope = Schema.Struct({ number: Schema.String, monitored: Schema.Array(Schema.String) })

/**
 * The metrics scope a query on the project reads: its own project number, and the numbers of
 * the projects it monitors, itself included. Needs `resourcemanager.projects.get`, which
 * Monitoring Viewer holds.
 */
export const getMetricsScope = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	projectId: GcpProjectId,
) =>
	call(
		httpClient,
		"Cloud Monitoring",
		HttpClientRequest.get(
			`https://monitoring.googleapis.com/v1/locations/global/metricsScopes/${projectId}`,
		).pipe(asReader(reader)),
		decodeMetricsScope,
		{ maxBytes: MAX_BODY_BYTES },
	).pipe(
		Effect.map((scope): typeof MetricsScope.Type => ({
			number: lastSegment(scope.name),
			monitored: (scope.monitoredProjects ?? []).map((project) => lastSegment(project.name)),
		})),
	)

// A kind or value type Google leaves unspecified is neither.
const isMetricKind = Schema.is(GcpMetricDescriptor.fields.metricKind)
const isValueType = Schema.is(GcpMetricDescriptor.fields.valueType)

const decodeMetricDescriptorsPage = Schema.decodeUnknownEffect(
	Schema.Struct({
		metricDescriptors: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					type: Schema.String,
					metricKind: Schema.optionalKey(Schema.String),
					valueType: Schema.optionalKey(Schema.String),
					unit: Schema.optionalKey(Schema.String),
					description: Schema.optionalKey(Schema.String),
					monitoredResourceTypes: Schema.optionalKey(Schema.Array(Schema.String)),
					labels: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String }))),
				}),
			),
		),
		nextPageToken: Schema.optionalKey(Schema.String),
	}),
)

/**
 * One page of the metrics with data in the project's last ~25 hours. A descriptor of a kind or
 * value type Google leaves unspecified is dropped.
 */
export const listActiveMetricDescriptorsPage = (
	httpClient: HttpClient.HttpClient,
	reader: GcpReader,
	projectId: GcpProjectId,
	pageToken: string | undefined,
) =>
	call(
		httpClient,
		"Cloud Monitoring",
		HttpClientRequest.get(
			`https://monitoring.googleapis.com/v3/projects/${projectId}/metricDescriptors`,
		).pipe(
			asReader(reader),
			HttpClientRequest.setUrlParams({ activeOnly: true, pageSize: 10_000, pageToken }),
		),
		decodeMetricDescriptorsPage,
		{ maxBytes: MAX_BODY_BYTES },
	).pipe(
		Effect.map((page) => ({
			descriptors: (page.metricDescriptors ?? []).flatMap((descriptor): Array<GcpMetricDescriptor> => {
				const { metricKind = "", valueType = "" } = descriptor
				if (!isMetricKind(metricKind) || !isValueType(valueType)) return []
				return [
					{
						type: descriptor.type,
						metricKind,
						valueType,
						unit: descriptor.unit ?? "",
						description: descriptor.description ?? "",
						monitoredResourceTypes: descriptor.monitoredResourceTypes ?? [],
						labels: (descriptor.labels ?? []).map((label) => label.key),
					},
				]
			}),
			nextPageToken: page.nextPageToken,
		})),
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

const decodeSqlInstancePage = Schema.decodeUnknownEffect(
	Schema.Struct({
		assets: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					/** The full resource name, as the search answers it. */
					name: Schema.String,
					resource: Schema.optionalKey(
						Schema.Struct({ data: Schema.optionalKey(SqlInstanceData) }),
					),
				}),
			),
		),
		nextPageToken: Schema.optionalKey(Schema.String),
	}),
)

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
	call(
		httpClient,
		"Cloud Asset Inventory",
		HttpClientRequest.get(`https://cloudasset.googleapis.com/v1/${scope}/assets`).pipe(
			asReader(reader),
			HttpClientRequest.setUrlParams({
				assetTypes: "sqladmin.googleapis.com/Instance",
				contentType: "RESOURCE",
				pageSize: RESOURCE_PAGE_SIZE,
				pageToken,
			}),
		),
		decodeSqlInstancePage,
	)
