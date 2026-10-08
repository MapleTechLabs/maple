import { afterEach, assert, beforeAll, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Fiber, Layer, Logger, References, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { GCP_ASSET_TYPES, GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { GcpMetricsService, MAX_PAGES_PER_METRIC, MAX_RESOURCE_PAGES, nextWindow } from "./GcpMetricsService"

const minute = 60_000
const now = Date.UTC(2026, 9, 8, 12, 30, 30)
/** Five minutes behind `now`, on a minute boundary. */
const horizon = Date.UTC(2026, 9, 8, 12, 25, 0)
const METRIC_COUNT = GCP_METRIC_GROUPS.reduce((sum, group) => sum + group.metrics.length, 0)

describe("nextWindow", () => {
	it("starts an hour back on a fresh connector and ends five minutes behind now", () => {
		assert.deepStrictEqual(nextWindow(null, now), { startMs: horizon - 60 * minute, endMs: horizon })
	})

	it("continues from the watermark, and is null once caught up", () => {
		const watermark = new Date(horizon - 5 * minute)
		assert.deepStrictEqual(nextWindow(watermark, now), { startMs: watermark.getTime(), endMs: horizon })
		assert.isNull(nextWindow(new Date(horizon), now))
	})

	it("never reaches back more than an hour: a long pause is skipped, not replayed", () => {
		const watermark = new Date(horizon - 48 * 60 * minute)
		assert.deepStrictEqual(nextWindow(watermark, now), {
			startMs: horizon - 60 * minute,
			endMs: horizon,
		})
	})
})

const MAPLE_ACCOUNT = "collector@maple-prod.iam.gserviceaccount.com"
const MAPLE_TOKEN = "ya29.maple-own-token"
const READER_TOKEN = "ya29.customer-reader-token"
const CONNECTOR_A = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const CONNECTOR_B = "028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const READER_A = "maple-018f2b3c4d5e4f708192a3b4@acme-prod.iam.gserviceaccount.com"
const REQUEST_COUNT = "run.googleapis.com/request_count"

let encodedKey = ""
let privateKeyBody = ""
let publicKey: CryptoKey

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)
	publicKey = pair.publicKey
	privateKeyBody = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")
	const lines = privateKeyBody.match(/.{1,64}/g)!.join("\n")
	encodedKey = Buffer.from(
		JSON.stringify({
			type: "service_account",
			private_key_id: "key-1",
			private_key: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
			client_email: MAPLE_ACCOUNT,
		}),
	).toString("base64")
})

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

interface ScopedCall {
	/** `projects/<id>`, `folders/<number>` or `organizations/<number>`. */
	readonly scope: string
	readonly params: URLSearchParams
	readonly authorization: string | null
	/** `x-goog-user-project`: the project whose quota the call uses. */
	readonly quotaProject: string | null
}

interface MonitoringCall extends ScopedCall {
	readonly metricType: string
}

interface Calls {
	readonly oauth: Array<string>
	readonly impersonate: Array<{
		readonly account: string
		readonly authorization: string | null
		readonly quotaProject: string | null
		readonly body: unknown
	}>
	readonly monitoring: Array<MonitoringCall>
	readonly assets: Array<ScopedCall>
	readonly ingest: Array<{ readonly authorization: string | null; readonly body: string }>
}

interface StubOptions {
	readonly oauth?: () => Response
	/** Answer for one impersonation; undefined grants a token. */
	readonly impersonate?: (account: string) => Response | undefined
	/** Answer for one `timeSeries.list` call; undefined answers "no series". */
	readonly monitoring?: (call: MonitoringCall) => Response | Promise<Response> | undefined
	/** Answer for one `searchAllResources` call; undefined answers "no resources". */
	readonly assets?: (call: ScopedCall) => Response | undefined
	readonly ingestStatus?: number
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const googleError = (status: number, code: string, details?: ReadonlyArray<unknown>) =>
	json(
		{
			error: {
				code: status,
				status: code,
				message: `details that must not be stored: ${code}`,
				...(details === undefined ? undefined : { details }),
			},
		},
		status,
	)

/** Google's machine-readable cause of a refusal, as `error.details` carries it. */
const errorInfo = (reason: string) => ({
	"@type": "type.googleapis.com/google.rpc.ErrorInfo",
	reason,
	domain: "googleapis.com",
	metadata: { consumer: "projects/123456789012", service: "monitoring.googleapis.com" },
})

// What Cloud Monitoring answered for a host project without billing on 2026-10-08, with the
// project number replaced: the cause is in the text only.
const NO_BILLING_ANSWER = {
	error: {
		code: 403,
		message:
			"This API method requires billing to be enabled. Please enable billing on project #123456789012 by visiting https://console.developers.google.com/billing/enable?project=123456789012 then retry. If you enabled billing for this project recently, wait a few minutes for the action to propagate to our systems and retry.",
		status: "PERMISSION_DENIED",
	},
}

/** One Cloud Run series with two points inside the first poll's window. */
const requestCountSeries = (projectId = "acme-prod") => ({
	timeSeries: [
		{
			metric: { type: REQUEST_COUNT, labels: { response_code_class: "2xx" } },
			resource: {
				type: "cloud_run_revision",
				labels: { project_id: projectId, service_name: "checkout", location: "europe-west4" },
			},
			metricKind: "DELTA",
			valueType: "INT64",
			points: [
				{
					interval: { startTime: "2026-10-08T12:23:00Z", endTime: "2026-10-08T12:24:00Z" },
					value: { int64Value: "12" },
				},
				{
					interval: { startTime: "2026-10-08T12:22:00Z", endTime: "2026-10-08T12:23:00Z" },
					value: { int64Value: "30" },
				},
			],
		},
	],
})

const onlyRequestCount = (call: MonitoringCall) =>
	call.metricType === REQUEST_COUNT ? json(requestCountSeries()) : undefined

const runService = (name: string, projectId = "acme-prod") => ({
	name: `//run.googleapis.com/projects/${projectId}/locations/europe-west4/services/${name}`,
	assetType: "run.googleapis.com/Service",
	displayName: name,
	location: "europe-west4",
	labels: { team: "payments" },
	createTime: "2026-01-02T03:04:05Z",
	updateTime: "2026-10-01T00:00:00Z",
})

const project = (projectId: string, number: string) => ({
	name: `//cloudresourcemanager.googleapis.com/projects/${number}`,
	assetType: "cloudresourcemanager.googleapis.com/Project",
	displayName: projectId,
	state: "ACTIVE",
	additionalAttributes: { projectId },
})

const stubFetch = (calls: Calls, options: StubOptions = {}) =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
		)
		const headers = new Headers(init?.headers)
		const authorization = headers.get("authorization")
		const quotaProject = headers.get("x-goog-user-project")
		const body = await new Response(init?.body ?? null).text()
		if (url.host === "oauth2.googleapis.com") {
			calls.oauth.push(new URLSearchParams(body).get("assertion") ?? "")
			return options.oauth?.() ?? json({ access_token: MAPLE_TOKEN, expires_in: 600 })
		}
		if (url.host === "iamcredentials.googleapis.com") {
			const account = decodeURIComponent(
				url.pathname
					.replace("/v1/projects/-/serviceAccounts/", "")
					.replace(":generateAccessToken", ""),
			)
			calls.impersonate.push({ account, authorization, quotaProject, body: JSON.parse(body) })
			return options.impersonate?.(account) ?? json({ accessToken: READER_TOKEN })
		}
		if (url.host === "monitoring.googleapis.com") {
			const filter = url.searchParams.get("filter") ?? ""
			const call = {
				scope: url.pathname.replace("/v3/", "").replace("/timeSeries", ""),
				metricType: /metric\.type = "([^"]+)"/.exec(filter)?.[1] ?? "",
				params: url.searchParams,
				authorization,
				quotaProject,
			}
			calls.monitoring.push(call)
			return (await options.monitoring?.(call)) ?? json({})
		}
		if (url.host === "cloudasset.googleapis.com") {
			const call = {
				scope: url.pathname.replace("/v1/", "").replace(":searchAllResources", ""),
				params: url.searchParams,
				authorization,
				quotaProject,
			}
			calls.assets.push(call)
			return options.assets?.(call) ?? json({})
		}
		if (url.host === "ingest.test") {
			calls.ingest.push({ authorization, body })
			return json({}, options.ingestStatus ?? 200)
		}
		throw new Error(`unexpected request to ${url.host}`)
	}) as typeof fetch

const makeCalls = (): Calls => ({ oauth: [], impersonate: [], monitoring: [], assets: [], ingest: [] })

/** Everything a tick logs or traces, as one string to search for secrets. */
const makeRecorder = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const logs: Array<string> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	const logger = Logger.make(({ fiber, message }) => {
		logs.push(JSON.stringify([message, fiber.getRef(References.CurrentLogAnnotations)]))
	})
	/** Spans that ended in a failure: what an exporter would report as an error. */
	const failedSpans = () =>
		spans.flatMap((span) =>
			span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
				? [`${span.name}: ${String(span.status.exit.cause)}`]
				: [],
		)
	return {
		tracer,
		logger,
		failedSpans,
		text: () =>
			JSON.stringify([
				logs,
				spans.map((span) => [span.name, [...span.attributes], span.events]),
				failedSpans(),
			]),
	}
}

const run = <A, E>(
	testDb: TestDb,
	stub: typeof fetch,
	effect: Effect.Effect<A, E, GcpMetricsService>,
	options: { readonly key?: string | null; readonly recorder?: ReturnType<typeof makeRecorder> } = {},
) => {
	const key = options.key === undefined ? encodedKey : options.key
	const recorder = options.recorder ?? makeRecorder()
	return Effect.gen(function* () {
		yield* TestClock.setTime(now)
		return yield* effect
	}).pipe(
		Effect.provideService(FetchHttpClient.Fetch, stub),
		Effect.provide(
			Layer.effect(GcpMetricsService, GcpMetricsService.make).pipe(
				Layer.provide(Layer.mergeAll(FetchHttpClient.layer, OrgIngestKeysService.layer)),
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub)),
				Layer.provide(testDb.layer),
				Layer.provide(Env.layer),
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							PORT: "3472",
							TINYBIRD_HOST: "https://api.tinybird.co",
							TINYBIRD_TOKEN: "test-token",
							MAPLE_AUTH_MODE: "self_hosted",
							MAPLE_ROOT_PASSWORD: "test-root-password",
							MAPLE_DEFAULT_ORG_ID: "default",
							MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
							MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
							MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
							...(key === null ? undefined : { MAPLE_GCP_SERVICE_ACCOUNT_KEY: key }),
						}),
					),
				),
			),
		),
		Effect.provideService(Tracer.Tracer, recorder.tracer),
		Effect.provideService(Logger.CurrentLoggers, new Set([recorder.logger])),
	)
}

const insertConnector = (
	testDb: TestDb,
	id: string,
	options: {
		readonly orgId?: string
		/** The host project, and the scope unless `scope` says otherwise. */
		readonly projectId?: string
		readonly scope?: readonly [type: "folder" | "organization", id: string]
		readonly metricsEnabled?: boolean
	} = {},
) => {
	const projectId = options.projectId ?? "acme-prod"
	const [scopeType, scopeId] = options.scope ?? ["project", projectId]
	return Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO gcp_connectors
			   (id, org_id, scope_type, scope_id, project_id, secret_ciphertext, secret_iv, secret_tag,
			    secret_hash, metrics_enabled, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'c', 'i', 't', $1, $6, 'user_1', now(), now())`,
			[id, options.orgId ?? "org_gcp", scopeType, scopeId, projectId, options.metricsEnabled ?? true],
		),
	)
}

interface PollState {
	readonly metrics_watermark_at: Date | null
	readonly last_metrics_received_at: Date | null
	readonly last_metrics_error: string | null
	readonly metrics_lease_until: Date | null
	readonly resources_synced_at: Date | null
	readonly last_resources_error: string | null
}

const pollState = (testDb: TestDb, id: string) =>
	Effect.promise(() =>
		queryFirstRow<PollState>(
			testDb,
			`SELECT metrics_watermark_at, last_metrics_received_at, last_metrics_error, metrics_lease_until,
			        resources_synced_at, last_resources_error
			 FROM gcp_connectors WHERE id = $1`,
			[id],
		),
	).pipe(Effect.map((row) => row!))

/** The connector's inventory as `asset type -> display name` pairs, in name order. */
const inventory = (testDb: TestDb, id: string) =>
	Effect.promise(() =>
		queryFirstRow<{ readonly resources: ReadonlyArray<ReadonlyArray<string>> | null }>(
			testDb,
			`SELECT json_agg(json_build_array(project_id, asset_type, display_name) ORDER BY name) AS resources
			 FROM gcp_resources WHERE connector_id = $1`,
			[id],
		),
	).pipe(Effect.map((row) => row?.resources ?? []))

const pollAll = GcpMetricsService.use((gcp) => gcp.pollAll())

const decodeJwtPart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

describe("GcpMetricsService", () => {
	it.effect("signs in as Maple, impersonates the connector's reader and ships its metrics", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const recorder = makeRecorder()
		return run(
			testDb,
			stubFetch(calls, { monitoring: onlyRequestCount }),
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				const summary = yield* pollAll
				assert.deepInclude(summary, { polled: 1, deferred: 0, rowsIngested: 2, failures: 0 })

				// The assertion is an RS256 JWT from Maple's account, valid for ten minutes.
				assert.lengthOf(calls.oauth, 1)
				const [header, claims, signature] = calls.oauth[0]!.split(".") as [string, string, string]
				assert.deepStrictEqual(decodeJwtPart(header), { alg: "RS256", typ: "JWT", kid: "key-1" })
				assert.deepStrictEqual(decodeJwtPart(claims), {
					iss: MAPLE_ACCOUNT,
					scope: "https://www.googleapis.com/auth/iam",
					aud: "https://oauth2.googleapis.com/token",
					iat: Math.floor(now / 1000),
					exp: Math.floor(now / 1000) + 600,
				})
				assert.isTrue(
					yield* Effect.promise(() =>
						crypto.subtle.verify(
							"RSASSA-PKCS1-v1_5",
							publicKey,
							Buffer.from(signature, "base64url"),
							new TextEncoder().encode(`${header}.${claims}`),
						),
					),
				)

				// Impersonation runs on Maple's own quota; everything read as the reader on its project's.
				assert.deepStrictEqual(calls.impersonate, [
					{
						account: READER_A,
						authorization: `Bearer ${MAPLE_TOKEN}`,
						quotaProject: null,
						body: {
							scope: ["https://www.googleapis.com/auth/cloud-platform"],
							lifetime: "600s",
						},
					},
				])

				assert.lengthOf(calls.monitoring, METRIC_COUNT)
				assert.isTrue(
					calls.monitoring.every(
						(call) =>
							call.scope === "projects/acme-prod" &&
							call.authorization === `Bearer ${READER_TOKEN}` &&
							call.quotaProject === "acme-prod",
					),
				)
				const query = calls.monitoring.find((call) => call.metricType === REQUEST_COUNT)!
				assert.includeDeepMembers(
					[...query.params],
					[
						[
							"filter",
							`metric.type = "${REQUEST_COUNT}" AND resource.type = "cloud_run_revision"`,
						],
						["interval.startTime", "2026-10-08T11:25:00.000Z"],
						["interval.endTime", "2026-10-08T12:25:00.000Z"],
						["aggregation.alignmentPeriod", "60s"],
						["aggregation.perSeriesAligner", "ALIGN_DELTA"],
						["aggregation.crossSeriesReducer", "REDUCE_SUM"],
						["aggregation.groupByFields", "resource.label.project_id"],
						["aggregation.groupByFields", "resource.label.service_name"],
						["aggregation.groupByFields", "resource.label.location"],
						["aggregation.groupByFields", "metric.label.response_code_class"],
					],
				)

				assert.lengthOf(calls.ingest, 1)
				assert.match(calls.ingest[0]!.authorization ?? "", /^Bearer maple_pk_/)
				const payload = JSON.parse(calls.ingest[0]!.body)
				const resource = payload.resourceMetrics[0]
				const attributes = Object.fromEntries(
					resource.resource.attributes.map(
						(attribute: { key: string; value: { stringValue: string } }) => [
							attribute.key,
							attribute.value.stringValue,
						],
					),
				)
				assert.deepInclude(attributes, {
					"service.name": "checkout",
					"cloud.provider": "gcp",
					"cloud.account.id": "acme-prod",
				})
				const metric = resource.scopeMetrics[0].metrics[0]
				assert.strictEqual(metric.name, "gcp.run.request_count")
				assert.strictEqual(metric.sum.aggregationTemporality, 1)
				assert.deepStrictEqual(
					metric.sum.dataPoints.map((point: { asDouble: number }) => point.asDouble),
					[12, 30],
				)

				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon)
				assert.strictEqual(state.last_metrics_received_at?.getTime(), now)
				assert.isNull(state.last_metrics_error)

				// No credential in anything the tick logged or traced.
				const recorded = recorder.text()
				assert.include(recorded, "GcpMetricsService.pollConnector")
				// The HTTP client's spans are in there, with the Authorization header redacted.
				assert.include(recorded, "iamcredentials.googleapis.com")
				assert.include(recorded, '["http.request.header.authorization","<redacted>"]')
				for (const secret of [MAPLE_TOKEN, READER_TOKEN, privateKeyBody.slice(0, 40), signature]) {
					assert.notInclude(recorded, secret)
				}
			}),
			{ recorder },
		)
	})

	it.effect("reads a whole organization in one query per metric, attributing each project", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const stub = stubFetch(calls, {
			monitoring: (call) =>
				call.metricType === REQUEST_COUNT
					? json({
							timeSeries: [
								...requestCountSeries("shop-prod").timeSeries,
								...requestCountSeries("shop-staging").timeSeries,
							],
						})
					: undefined,
			assets: () => json({ results: [project("shop-prod", "111"), project("shop-staging", "222")] }),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				// The reader account lives in the host project; its roles are granted on the organization.
				yield* insertConnector(testDb, CONNECTOR_A, { scope: ["organization", "123456789012"] })
				assert.deepInclude(yield* pollAll, { polled: 1, rowsIngested: 4, failures: 0 })
				assert.deepStrictEqual(
					calls.impersonate.map((call) => call.account),
					[READER_A],
				)
				assert.lengthOf(calls.monitoring, METRIC_COUNT)
				assert.isTrue(calls.monitoring.every((call) => call.scope === "organizations/123456789012"))
				assert.deepStrictEqual(
					calls.assets.map((call) => call.scope),
					["organizations/123456789012"],
				)

				const payload = JSON.parse(calls.ingest[0]!.body)
				const accounts = payload.resourceMetrics.map(
					(resource: {
						resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }
					}) =>
						resource.resource.attributes.find((attribute) => attribute.key === "cloud.account.id")
							?.value.stringValue,
				)
				assert.sameMembers(accounts, ["shop-prod", "shop-staging"])
				assert.deepStrictEqual(yield* inventory(testDb, CONNECTOR_A), [
					["shop-prod", "cloudresourcemanager.googleapis.com/Project", "shop-prod"],
					["shop-staging", "cloudresourcemanager.googleapis.com/Project", "shop-staging"],
				])
			}),
		)
	})

	it.effect("advances the watermark tick by tick, and waits out a live lease", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls),
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				yield* pollAll

				// An overlapping tick a minute later finds the lease held and does nothing.
				yield* TestClock.setTime(now + minute)
				assert.deepInclude(yield* pollAll, { polled: 0, calls: 0 })
				assert.lengthOf(calls.oauth, 1)

				// The next cron tick reads exactly the five minutes that followed.
				yield* TestClock.setTime(now + 5 * minute)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0 })
				const second = calls.monitoring.at(-1)!.params
				assert.strictEqual(second.get("interval.startTime"), "2026-10-08T12:25:00.000Z")
				assert.strictEqual(second.get("interval.endTime"), "2026-10-08T12:30:00.000Z")
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon + 5 * minute)

				// Metrics that were off for days resume with the last hour, not a replay of the gap.
				yield* Effect.promise(() =>
					executeSql(testDb, "UPDATE gcp_connectors SET metrics_watermark_at = $1", [
						"2026-10-01T00:00:00.000Z",
					]),
				)
				yield* TestClock.setTime(now + 10 * minute)
				yield* pollAll
				assert.strictEqual(
					calls.monitoring.at(-1)!.params.get("interval.startTime"),
					"2026-10-08T11:35:00.000Z",
				)
			}),
		)
	})

	it.effect("polls only connectors with metrics enabled", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls),
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A, { metricsEnabled: false })
				assert.deepInclude(yield* pollAll, { polled: 0, deferred: 0, calls: 0 })
				assert.isNull((yield* pollState(testDb, CONNECTOR_A)).metrics_lease_until)

				yield* insertConnector(testDb, CONNECTOR_B, { projectId: "acme-staging" })
				assert.deepInclude(yield* pollAll, { polled: 1 })
				assert.deepStrictEqual(
					calls.impersonate.map((call) => call.account),
					["maple-028f2b3c4d5e4f708192a3b4@acme-staging.iam.gserviceaccount.com"],
				)
			}),
		)
	})

	it.effect("is a no-op without a service account key", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls),
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 0, calls: 0 })
				assert.deepStrictEqual(calls, makeCalls())
				assert.isNull((yield* pollState(testDb, CONNECTOR_A)).metrics_lease_until)
			}),
			{ key: null },
		)
	})

	it.effect("tells a scope that has not run the script what to do, for one call per tick", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const recorder = makeRecorder()
		const stub = stubFetch(calls, {
			impersonate: (account) =>
				account === READER_A ? googleError(403, "PERMISSION_DENIED") : undefined,
			monitoring: onlyRequestCount,
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				yield* insertConnector(testDb, CONNECTOR_B, { orgId: "org_other", projectId: "other-prod" })
				const summary = yield* pollAll
				// The denied connector does not hold back the other organization's.
				assert.deepInclude(summary, { polled: 2, failures: 1, rowsIngested: 2 })
				assert.isTrue(calls.monitoring.every((call) => call.scope === "projects/other-prod"))

				const denied = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(
					denied.last_metrics_error,
					"Google IAM returned 403 PERMISSION_DENIED. Run the setup script in Cloud Shell to grant Maple read access; if it already ran, wait a few minutes for the grant to apply.",
				)
				assert.isNull(denied.metrics_watermark_at)
				assert.isNull(denied.last_metrics_received_at)

				// Retried at tick cadence, and an expected state is not an exception on a span.
				yield* TestClock.setTime(now + 5 * minute)
				yield* pollAll
				assert.lengthOf(
					calls.impersonate.filter((call) => call.account === READER_A),
					2,
				)
				assert.notInclude(recorder.text(), "must not be stored")
				assert.deepStrictEqual(recorder.failedSpans(), [])
			}),
			{ recorder },
		)
	})

	it.effect("stops paging a metric at the cap and reports it", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const stub = stubFetch(calls, {
			monitoring: (call) =>
				call.metricType === REQUEST_COUNT
					? json({ ...requestCountSeries(), nextPageToken: `page-${calls.monitoring.length}` })
					: undefined,
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				const summary = yield* pollAll
				assert.deepInclude(summary, { polled: 1, failures: 0, incompleteMetrics: 1 })
				const pages = calls.monitoring.filter((call) => call.metricType === REQUEST_COUNT)
				assert.lengthOf(pages, MAX_PAGES_PER_METRIC)
				assert.isNull(pages[0]!.params.get("pageToken"))
				assert.isNotNull(pages.at(-1)!.params.get("pageToken"))
				// What was read is kept, and the window is not read again.
				assert.strictEqual(summary.rowsIngested, 2 * MAX_PAGES_PER_METRIC)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon)
				assert.strictEqual(
					state.last_metrics_error,
					`1 of ${METRIC_COUNT} metric queries held more than one poll reads; connect folders or projects separately to collect all of it.`,
				)
			}),
		)
	})

	it.effect("stops every poll in flight once the tick has made its share of requests", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		// Every query has another page, so a connector alone would make 460 requests.
		const stub = stubFetch(calls, { monitoring: () => json({ nextPageToken: "more" }) })
		const connectorId = (index: number) => `0${index.toString(16)}8f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8`
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				// Two organizations, so the per-organization cap is not what stops them.
				for (let index = 0; index < 12; index++) {
					yield* insertConnector(testDb, connectorId(index), {
						orgId: index < 6 ? "org_gcp" : "org_other",
						projectId: `acme-prod-${index}`,
					})
				}
				const summary = yield* pollAll
				// Three polls run at once, so the gate can be passed by a request or two each.
				assert.isAtLeast(summary.calls, 3_000)
				assert.isBelow(summary.calls, 3_010)
				// The polls in flight stopped mid-table, and the connectors behind them never started.
				assert.isAbove(summary.incompleteMetrics, 0)
				assert.isAbove(summary.deferred, 0)
			}),
		)
	})

	it.effect("reads a metric type the scope never used as empty, not as a failure", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		let everyTypeUnknown = false
		const stub = stubFetch(calls, {
			monitoring: (call) =>
				everyTypeUnknown || call.metricType !== REQUEST_COUNT
					? googleError(404, "NOT_FOUND")
					: json(requestCountSeries()),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0, rowsIngested: 2 })
				assert.lengthOf(calls.monitoring, METRIC_COUNT)
				assert.isNull((yield* pollState(testDb, CONNECTOR_A)).last_metrics_error)

				// A scope with nothing in it is an empty poll that still moves on.
				everyTypeUnknown = true
				yield* TestClock.setTime(now + 5 * minute)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0, rowsIngested: 0 })
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.isNull(state.last_metrics_error)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon + 5 * minute)
			}),
		)
	})

	it.effect("skips a metric Cloud Monitoring rejects and still ships the rest", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const rejected = "run.googleapis.com/request_latencies"
		const stub = stubFetch(calls, {
			monitoring: (call) =>
				call.metricType === rejected ? googleError(400, "INVALID_ARGUMENT") : onlyRequestCount(call),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0, rowsIngested: 2 })
				assert.lengthOf(calls.monitoring, METRIC_COUNT)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(
					state.last_metrics_error,
					`1 of ${METRIC_COUNT} metric queries failed. First: ${rejected}: Cloud Monitoring returned 400 INVALID_ARGUMENT.`,
				)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon)
			}),
		)
	})

	it.effect("stops at the first denied query and keeps the window for the next tick", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const stub = stubFetch(calls, { monitoring: () => googleError(403, "PERMISSION_DENIED") })
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 1, rowsIngested: 0 })
				assert.lengthOf(calls.monitoring, 1)
				assert.lengthOf(calls.ingest, 0)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.match(
					state.last_metrics_error ?? "",
					/^Cloud Monitoring returned 403 PERMISSION_DENIED\. Run the setup script/,
				)
				assert.isNull(state.metrics_watermark_at)
			}),
		)
	})

	it.effect("names missing billing or a disabled API only where Google gives the reason as a code", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const recorder = makeRecorder()
		let monitoring = () => json(NO_BILLING_ANSWER, 403)
		let impersonate: () => Response | undefined = () => undefined
		const stub = stubFetch(calls, {
			impersonate: () => impersonate(),
			monitoring: () => monitoring(),
			assets: () =>
				googleError(403, "PERMISSION_DENIED", [
					{ "@type": "type.googleapis.com/google.rpc.Help", links: [] },
					errorInfo("SERVICE_DISABLED"),
				]),
		})
		const metricsError = pollState(testDb, CONNECTOR_A).pipe(
			Effect.map((state) => state.last_metrics_error),
		)
		const hint =
			"Run the setup script in Cloud Shell to grant Maple read access; if it already ran, wait a few minutes for the grant to apply."
		const generic = `Cloud Monitoring returned 403 PERMISSION_DENIED. ${hint}`
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				yield* pollAll
				assert.strictEqual(yield* metricsError, generic)
				assert.strictEqual(
					(yield* pollState(testDb, CONNECTOR_A)).last_resources_error,
					"Cloud Asset Inventory returned 403 PERMISSION_DENIED (SERVICE_DISABLED). This API is not enabled in the host project acme-prod; run the setup script again.",
				)

				monitoring = () => googleError(403, "PERMISSION_DENIED", [errorInfo("BILLING_DISABLED")])
				yield* TestClock.setTime(now + 5 * minute)
				yield* pollAll
				assert.strictEqual(
					yield* metricsError,
					"Cloud Monitoring returned 403 PERMISSION_DENIED (BILLING_DISABLED). This API requires billing to be enabled on the host project acme-prod.",
				)

				// A reason that does not read like one of Google's codes is dropped.
				monitoring = () =>
					googleError(403, "PERMISSION_DENIED", [errorInfo("billing: see example.com")])
				yield* TestClock.setTime(now + 10 * minute)
				yield* pollAll
				assert.strictEqual(yield* metricsError, generic)

				// Signing in as the reader does not go through the host project.
				impersonate = () => googleError(403, "PERMISSION_DENIED", [errorInfo("SERVICE_DISABLED")])
				yield* TestClock.setTime(now + 15 * minute)
				yield* pollAll
				assert.strictEqual(
					yield* metricsError,
					`Google IAM returned 403 PERMISSION_DENIED (SERVICE_DISABLED). ${hint}`,
				)

				// Details of another form cost neither the status code nor the poll.
				impersonate = () => undefined
				monitoring = () =>
					json({ error: { status: "PERMISSION_DENIED", details: "BILLING_DISABLED" } }, 403)
				yield* TestClock.setTime(now + 20 * minute)
				yield* pollAll
				assert.strictEqual(yield* metricsError, generic)

				const recorded = recorder.text()
				assert.include(recorded, "BILLING_DISABLED")
				for (const text of [
					"Please enable billing",
					"must not be stored",
					"example.com",
					"123456789012",
				]) {
					assert.notInclude(recorded, text)
				}
			}),
			{ recorder },
		)
	})

	it.effect("tries a query Google failed once more, then skips it for this window", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const flaky = "run.googleapis.com/request_latencies"
		const broken = "run.googleapis.com/container/instance_count"
		let flakyCalls = 0
		const stub = stubFetch(calls, {
			monitoring: (call) => {
				if (call.metricType === broken) return googleError(503, "UNAVAILABLE")
				if (call.metricType === flaky && flakyCalls++ === 0) return googleError(500, "INTERNAL")
				return onlyRequestCount(call)
			},
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0, rowsIngested: 2 })
				assert.lengthOf(calls.monitoring, METRIC_COUNT + 2)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(
					state.last_metrics_error,
					`1 of ${METRIC_COUNT} metric queries failed. First: ${broken}: Cloud Monitoring returned 503 UNAVAILABLE.`,
				)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon)
			}),
		)
	})

	it.effect("stops querying when the quota runs out, keeping and moving past what it read", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const stub = stubFetch(calls, {
			// The first query is answered, the second is rate limited.
			monitoring: () =>
				calls.monitoring.length === 1
					? json(requestCountSeries())
					: googleError(429, "RESOURCE_EXHAUSTED"),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0 })
				assert.lengthOf(calls.monitoring, 2)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.match(
					state.last_metrics_error ?? "",
					new RegExp(
						`^${METRIC_COUNT - 1} of ${METRIC_COUNT} metric queries failed\\. First: .+: Cloud Monitoring returned 429 RESOURCE_EXHAUSTED\\.$`,
					),
				)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon)
			}),
		)
	})

	it.effect("stops a poll at its time budget when Google does not answer, keeping the window", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		let reached = () => {}
		const firstQuery = new Promise<void>((resolve) => {
			reached = resolve
		})
		const stub = stubFetch(calls, {
			monitoring: () => {
				reached()
				return new Promise<Response>(() => {})
			},
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				const fiber = yield* Effect.forkChild(pollAll)
				yield* Effect.promise(() => firstQuery)
				yield* TestClock.adjust("2 minutes")
				assert.deepInclude(yield* Fiber.join(fiber), { polled: 1, failures: 1 })
				// A few queries time out and pass the poll's minute; the rest are never sent.
				assert.isBelow(calls.monitoring.length, METRIC_COUNT)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(state.last_metrics_error, "Cloud Monitoring request timed out")
				assert.isNull(state.metrics_watermark_at)
			}),
		)
	})

	it.effect("holds every connector of an organization that is over its plan limit for an hour", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const paused = "Metrics are paused: this organization is over its plan limit."
		return run(
			testDb,
			stubFetch(calls, { monitoring: onlyRequestCount, ingestStatus: 402 }),
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				// A second connector of the organization that another tick still holds for a minute.
				yield* insertConnector(testDb, CONNECTOR_B, { projectId: "acme-staging" })
				yield* Effect.promise(() =>
					executeSql(testDb, "UPDATE gcp_connectors SET metrics_lease_until = $1 WHERE id = $2", [
						new Date(now + minute).toISOString(),
						CONNECTOR_B,
					]),
				)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 1, rowsIngested: 0 })
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(state.last_metrics_error, paused)
				assert.isNull(state.metrics_watermark_at)

				// Neither is read again before the hour is over.
				const sibling = yield* pollState(testDb, CONNECTOR_B)
				assert.strictEqual(sibling.last_metrics_error, paused)
				assert.strictEqual(sibling.metrics_lease_until?.getTime(), now + 60 * minute)
				yield* TestClock.setTime(now + 30 * minute)
				assert.deepInclude(yield* pollAll, { polled: 0, calls: 0 })
			}),
		)
	})

	it.effect("takes at most ten connectors of one organization per tick, the rest next time", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const connectorId = (index: number) => `0${index.toString(16)}8f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8`
		const other = "ff8f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
		return run(
			testDb,
			stubFetch(calls),
			Effect.gen(function* () {
				for (let index = 0; index < 12; index++) {
					yield* insertConnector(testDb, connectorId(index), { projectId: `acme-prod-${index}` })
				}
				yield* insertConnector(testDb, other, { orgId: "org_other", projectId: "other-prod" })
				assert.deepInclude(yield* pollAll, { polled: 11, deferred: 2 })
				assert.isNotNull((yield* pollState(testDb, other)).metrics_watermark_at)

				// Never polled sorts first: the two that waited go before the ones that are due again.
				yield* TestClock.setTime(now + 5 * minute)
				const before = calls.impersonate.length
				assert.deepInclude(yield* pollAll, { polled: 11, deferred: 2 })
				const order = calls.impersonate.slice(before).map((call) => call.account.split("@")[1])
				assert.sameMembers(order.slice(0, 2), [
					"acme-prod-10.iam.gserviceaccount.com",
					"acme-prod-11.iam.gserviceaccount.com",
				])
			}),
		)
	})

	it.effect("fails the tick, without the key in the error, when Google rejects Maple's sign-in", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const stub = stubFetch(calls, {
			oauth: () => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				const error = yield* Effect.flip(pollAll)
				assert.deepInclude(error, {
					_tag: "@maple/api/integrations/GcpApiError",
					kind: "invalid",
					message: "Google OAuth returned 400 invalid_grant",
				})
				assert.lengthOf(calls.impersonate, 0)
				// Maple's own misconfiguration is not the customer's error.
				assert.isNull((yield* pollState(testDb, CONNECTOR_A)).last_metrics_error)
			}),
		)
	})

	it.effect("fails the tick on a key that is not a service account key, without quoting it", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const notAKey = Buffer.from(JSON.stringify({ private_key: "super-secret-material" })).toString(
			"base64",
		)
		return run(
			testDb,
			stubFetch(calls),
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				const error = yield* Effect.flip(pollAll)
				assert.strictEqual(
					error.message,
					"MAPLE_GCP_SERVICE_ACCOUNT_KEY is not a base64-encoded service account key",
				)
				assert.notInclude(JSON.stringify(error), "super-secret-material")
				assert.lengthOf(calls.oauth, 0)
			}),
			{ key: notAKey },
		)
	})
})

describe("GcpMetricsService resource inventory", () => {
	it.effect("syncs the scope's resources hourly, replacing what changed and removing what is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		let results: ReadonlyArray<unknown> = [
			project("acme-prod", "111"),
			runService("checkout"),
			// The same name twice in one page is stored once.
			{ ...runService("cart"), displayName: "cart (listed twice)" },
			runService("cart"),
			// Nothing to attribute it to: not stored.
			{ name: "//cloudresourcemanager.googleapis.com/folders/42", assetType: "x/Folder" },
		]
		const stub = stubFetch(calls, {
			assets: (call) =>
				call.params.get("pageToken") === null
					? json({ results: results.slice(0, 2), nextPageToken: "next" })
					: json({ results: results.slice(2) }),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A, { scope: ["folder", "42"] })
				yield* pollAll
				assert.lengthOf(calls.assets, 2)
				assert.deepInclude(calls.assets[0], {
					scope: "folders/42",
					authorization: `Bearer ${READER_TOKEN}`,
					quotaProject: "acme-prod",
				})
				assert.deepStrictEqual(calls.assets[0]!.params.getAll("assetTypes"), [...GCP_ASSET_TYPES])
				assert.deepStrictEqual(yield* inventory(testDb, CONNECTOR_A), [
					["acme-prod", "cloudresourcemanager.googleapis.com/Project", "acme-prod"],
					["acme-prod", "run.googleapis.com/Service", "cart"],
					["acme-prod", "run.googleapis.com/Service", "checkout"],
				])
				const synced = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(synced.resources_synced_at?.getTime(), now)
				assert.isNull(synced.last_resources_error)

				// Metrics ticks in between leave the inventory alone.
				results = [
					project("acme-prod", "111"),
					{ ...runService("checkout"), displayName: "Checkout" },
				]
				yield* TestClock.setTime(now + 55 * minute)
				yield* pollAll
				assert.lengthOf(calls.assets, 2)

				yield* TestClock.setTime(now + 60 * minute)
				yield* pollAll
				assert.lengthOf(calls.assets, 4)
				assert.deepStrictEqual(yield* inventory(testDb, CONNECTOR_A), [
					["acme-prod", "cloudresourcemanager.googleapis.com/Project", "acme-prod"],
					["acme-prod", "run.googleapis.com/Service", "Checkout"],
				])
			}),
		)
	})

	it.effect("reports a denied inventory on its own field, retries it, and still ships metrics", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const stub = stubFetch(calls, {
			monitoring: onlyRequestCount,
			assets: () => googleError(403, "PERMISSION_DENIED"),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				assert.deepInclude(yield* pollAll, { polled: 1, failures: 0, rowsIngested: 2 })
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.match(
					state.last_resources_error ?? "",
					/^Cloud Asset Inventory returned 403 PERMISSION_DENIED\. Run the setup script/,
				)
				assert.isNull(state.resources_synced_at)
				assert.isNull(state.last_metrics_error)
				assert.strictEqual(state.metrics_watermark_at?.getTime(), horizon)

				yield* TestClock.setTime(now + 5 * minute)
				yield* pollAll
				assert.lengthOf(calls.assets, 2)
			}),
		)
	})

	it.effect("keeps what it has when the scope holds more than one sync reads", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		let endless = false
		const stub = stubFetch(calls, {
			assets: () =>
				endless
					? json({ results: [runService(`svc-${calls.assets.length}`)], nextPageToken: "more" })
					: json({ results: [runService("checkout")] }),
		})
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				yield* insertConnector(testDb, CONNECTOR_A)
				yield* pollAll
				endless = true
				yield* TestClock.setTime(now + 60 * minute)
				yield* pollAll
				assert.lengthOf(calls.assets, 1 + MAX_RESOURCE_PAGES)
				const state = yield* pollState(testDb, CONNECTOR_A)
				assert.strictEqual(
					state.last_resources_error,
					"The scope holds more than 10000 resources; the inventory is incomplete.",
				)
				// Counted as synced, so the next attempt is in an hour, and nothing was removed.
				assert.strictEqual(state.resources_synced_at?.getTime(), now + 60 * minute)
				const names = (yield* inventory(testDb, CONNECTOR_A)).map((row) => row[2])
				assert.lengthOf(names, 1 + MAX_RESOURCE_PAGES)
				assert.include(names, "checkout")
			}),
		)
	})
})
