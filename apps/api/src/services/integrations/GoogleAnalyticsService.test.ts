// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { googleAnalyticsLedger, googleAnalyticsState, oauthConnections } from "@maple/db"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { encryptAes256Gcm, parseBase64Aes256GcmKey } from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { GoogleAnalyticsOAuthService } from "@/services/auth/GoogleAnalyticsOAuthService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import { GoogleAnalyticsService } from "./GoogleAnalyticsService"
import type { OtlpMetricsPayload } from "./shared/otlp"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_ga")
const PROPERTY_ID = "123456789"

const ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString("base64")

const baseConfig = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
	GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
}

/** Sessions GA4 reports for a given `dateHour`, per call. Successive polls read successive entries. */
interface FetchOptions {
	/** One entry per `runReport` call: dateHour → sessions. */
	readonly reports: ReadonlyArray<ReadonlyMap<string, number>>
	readonly timeZone?: string
	/** Force every Data API call to fail with this HTTP status. */
	readonly dataApiStatus?: number
	readonly dataApiBody?: string
	otlpCalls: Array<OtlpMetricsPayload>
	reportCalls: Array<{ propertyId: string; body: unknown }>
}

/** T0's property-local date — see {@link T0}. Declared here because the fetch mock needs it. */
const T0_DATE = "2026-09-09"

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * `HttpClientRequest.bodyJsonUnsafe` does not hand `fetch` a string, so `String(init.body)` yields
 * "[object Object]" and every JSON.parse in the mock throws — which surfaces as an upstream
 * failure on the real code path rather than as an obviously broken test.
 */
const readBody = async (init: RequestInit | undefined): Promise<string> => {
	if (init?.body == null) return ""
	return typeof init.body === "string" ? init.body : await new Response(init.body as BodyInit).text()
}

/**
 * Stands in for Google's two APIs plus the ingest gateway. Only the `traffic` dataset returns
 * rows; the other five report nothing, which keeps assertions about emitted values unambiguous.
 */
const mockGoogleFetch = (options: FetchOptions): typeof globalThis.fetch => {
	let reportIndex = 0
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

		if (url.includes("/v1/metrics")) {
			options.otlpCalls.push(JSON.parse(await readBody(init)) as OtlpMetricsPayload)
			return json({ ok: true })
		}

		if (url.includes("/accountSummaries")) {
			return json({
				accountSummaries: [
					{
						displayName: "Acme",
						propertySummaries: [{ property: `properties/${PROPERTY_ID}`, displayName: "example.com" }],
					},
				],
			})
		}

		if (url.includes(":runReport")) {
			if (options.dataApiStatus !== undefined) {
				return new Response(options.dataApiBody ?? "{}", { status: options.dataApiStatus })
			}
			const body = JSON.parse(await readBody(init)) as {
				dimensions: Array<{ name: string }>
				metrics: Array<{ name: string }>
				dateRanges: Array<{ startDate: string; endDate: string }>
			}
			const propertyId = url.split("/properties/")[1]?.split(":")[0] ?? ""
			options.reportCalls.push({ propertyId, body })

			// Breakdown datasets report nothing — only `traffic` (dateHour alone) carries values.
			if (body.dimensions.length !== 1) return json({ rows: [] })
			// Each poll asks twice for `traffic`: the live head window and one backfill round.
			// Only the head window covers T0's hour, so the backfill legitimately reports nothing —
			// and, more to the point, must not consume a fixture entry, or "one entry per poll"
			// would silently become "one per call" and the revision assertions would drift.
			if (body.dateRanges[0]?.endDate !== T0_DATE) return json({ rows: [] })

			const report = options.reports[Math.min(reportIndex, options.reports.length - 1)]
			reportIndex += 1
			const metricNames = body.metrics.map((metric) => metric.name)
			return json({
				dimensionHeaders: [{ name: "dateHour" }],
				metricHeaders: metricNames.map((name) => ({ name })),
				rows: [...(report ?? new Map())].map(([dateHour, sessions]) => ({
					dimensionValues: [{ value: dateHour }],
					// Only `sessions` carries a value; the rest report zero.
					metricValues: metricNames.map((name) => ({ value: name === "sessions" ? String(sessions) : "0" })),
				})),
			})
		}

		// properties/{id} — the timezone lookup.
		if (url.includes("/properties/")) {
			return json({ displayName: "example.com", timeZone: options.timeZone ?? "UTC" })
		}

		return json({ error: { message: `unexpected url ${url}` } }, 500)
	}) as typeof globalThis.fetch
}

const makeLayer = (testDb: TestDb, fetchOptions: FetchOptions) =>
	GoogleAnalyticsService.layer.pipe(
		Layer.provideMerge(GoogleAnalyticsOAuthService.layer),
		Layer.provideMerge(OrgIngestKeysService.layer),
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(baseConfig))),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mockGoogleFetch(fetchOptions))),
	)

/** A live grant with a real encrypted, non-expiring access token. */
const seedConnection = Effect.gen(function* () {
	const database = yield* Database
	const key = yield* parseBase64Aes256GcmKey(ENCRYPTION_KEY_B64, (message) => new Error(message))
	const accessEnc = yield* encryptAes256Gcm("ga-access-token", key, (message) => new Error(message))
	const refreshEnc = yield* encryptAes256Gcm("ga-refresh-token", key, (message) => new Error(message))
	yield* database.execute((db) =>
		db.insert(oauthConnections).values({
			id: "conn-ga",
			orgId: ORG,
			provider: "google_analytics",
			externalUserId: "google-sub",
			externalUserEmail: "owner@example.com",
			externalAccountName: "Acme",
			connectedByUserId: "user_1",
			scope: "https://www.googleapis.com/auth/analytics.readonly",
			accessTokenCiphertext: accessEnc.ciphertext,
			accessTokenIv: accessEnc.iv,
			accessTokenTag: accessEnc.tag,
			refreshTokenCiphertext: refreshEnc.ciphertext,
			refreshTokenIv: refreshEnc.iv,
			refreshTokenTag: refreshEnc.tag,
			// Far future: the refresh path is exercised by the shared OAuth helper's own tests.
			expiresAt: new Date(Date.now() + 86_400_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		}),
	)
})

/** Every `google_analytics.sessions` data point across all OTLP batches, in order. */
const sessionPoints = (calls: ReadonlyArray<OtlpMetricsPayload>) =>
	calls.flatMap((payload) =>
		payload.resourceMetrics.flatMap((resource) =>
			resource.scopeMetrics.flatMap((scope) =>
				scope.metrics
					.filter((metric) => metric.name === "google_analytics.sessions")
					.flatMap((metric) => metric.sum?.dataPoints ?? []),
			),
		),
	)

/**
 * Fixed test wall-clock, and the `dateHour` that matches it.
 *
 * `it.effect` runs on a TestClock that starts at epoch 0, so every window the collector computes
 * would sit in 1970 and no fixture hour would ever fall inside it — the reconciliation assertions
 * would pass vacuously against an empty result. Each test sets the clock to T0 first, and the
 * fixture reports for T0's own hour.
 */
const T0 = Date.parse("2026-09-09T14:00:00Z")
const HOUR = "2026090914"

const options = (reports: ReadonlyArray<ReadonlyMap<string, number>>, extra: Partial<FetchOptions> = {}) =>
	({ reports, otlpCalls: [], reportCalls: [], ...extra }) satisfies FetchOptions

describe("GoogleAnalyticsService", () => {
	it.effect("discovers properties and creates a state row per dataset", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map([[HOUR, 10]])])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)

				const database = yield* Database
				const rows = yield* database.execute((db) =>
					db.select().from(googleAnalyticsState).where(eq(googleAnalyticsState.orgId, ORG)),
				)
				// Six datasets plus the discovery anchor.
				assert.strictEqual(rows.length, 7)
				const anchor = rows.find((row) => row.dataset === "__discovery__")
				assert.isNotNull(anchor?.discoveredAt ?? null)
				const traffic = rows.find((row) => row.dataset === "traffic")
				assert.strictEqual(traffic?.propertyName, "example.com")
				assert.strictEqual(traffic?.accountName, "Acme")
				assert.strictEqual(traffic?.timeZone, "UTC")
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("emits the raw value first, then only the delta on a revision", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			// Second poll revises the same hour upward; third revises it back down.
			const fetchOptions = options([
				new Map([[HOUR, 100]]),
				new Map([[HOUR, 140]]),
				new Map([[HOUR, 60]]),
			])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)
				yield* service.pollOrg(ORG)
				yield* service.pollOrg(ORG)

				const points = sessionPoints(fetchOptions.otlpCalls)
				assert.deepStrictEqual(
					points.map((point) => point.asDouble),
					[100, 40, -80],
				)
				// The whole point: the deltas sum to GA4's latest answer for the bucket.
				assert.strictEqual(
					points.reduce((total, point) => total + point.asDouble, 0),
					60,
				)
				// ...and every one of them is a DELTA sum at the same instant.
				const timestamps = new Set(points.map((point) => point.timeUnixNano))
				assert.strictEqual(timestamps.size, 1)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("writes nothing when a re-poll finds no change", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map([[HOUR, 100]]), new Map([[HOUR, 100]])])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)
				const afterFirst = fetchOptions.otlpCalls.length
				yield* service.pollOrg(ORG)

				assert.isAbove(afterFirst, 0)
				assert.strictEqual(sessionPoints(fetchOptions.otlpCalls).length, 1)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("records what it emitted in the ledger, scoped to the property and dataset", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map([[HOUR, 100]])])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)

				const database = yield* Database
				const ledger = yield* database.execute((db) =>
					db.select().from(googleAnalyticsLedger).where(eq(googleAnalyticsLedger.orgId, ORG)),
				)
				// Only `traffic` returned rows, so only it has a ledger entry: the five breakdown
				// datasets emitted nothing and must not accrue empty rows.
				assert.strictEqual(ledger.length, 1)
				assert.strictEqual(ledger[0]?.dataset, "traffic")
				assert.strictEqual(ledger[0]?.propertyId, PROPERTY_ID)
				const emitted = JSON.parse(ledger[0]?.emittedJson ?? "{}") as Record<string, number>
				assert.strictEqual(emitted["google_analytics.sessions"], 100)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("records the failure and keeps the frontier when the Data API errors", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map()], {
				dataApiStatus: 500,
				dataApiBody: '{"error":{"status":"INTERNAL"}}',
			})

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				const result = yield* service.pollOrg(ORG)

				assert.isAbove(result.failures, 0)
				const database = yield* Database
				const rows = yield* database.execute((db) =>
					db.select().from(googleAnalyticsState).where(eq(googleAnalyticsState.orgId, ORG)),
				)
				const traffic = rows.find((row) => row.dataset === "traffic")
				// Nothing landed, so the head frontier must not have moved.
				assert.isNull(traffic?.watermarkAt ?? null)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("stamps the connection revoked when Google rejects the grant", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map()], {
				dataApiStatus: 401,
				dataApiBody: '{"error":{"status":"UNAUTHENTICATED"}}',
			})

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)

				const database = yield* Database
				const rows = yield* database.execute((db) =>
					db.select().from(oauthConnections).where(eq(oauthConnections.orgId, ORG)),
				)
				assert.isNotNull(rows[0]?.revokedAt ?? null)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("holds the lease through a quota backoff instead of clearing it", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map()], {
				dataApiStatus: 429,
				dataApiBody: '{"error":{"status":"RESOURCE_EXHAUSTED"}}',
			})

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)

				const database = yield* Database
				const rows = yield* database.execute((db) =>
					db.select().from(googleAnalyticsState).where(eq(googleAnalyticsState.orgId, ORG)),
				)
				const leased = rows.filter((row) => row.leaseUntil != null && row.leaseUntil > new Date())
				// The lease must still be in the future — clearing it would let the next tick spend
				// the rest of the org's GA4 budget immediately.
				assert.isAbove(leased.length, 0)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("skips a property the user disabled", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map([[HOUR, 10]])])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)
				yield* service.setPropertyEnabled(ORG, PROPERTY_ID, false)

				const before = fetchOptions.reportCalls.length
				yield* service.pollOrg(ORG)
				assert.strictEqual(fetchOptions.reportCalls.length, before)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("reports per-property status for the integration card", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map([[HOUR, 10]])])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)

				const status = yield* service.getIntegrationStatus(ORG)
				assert.isTrue(status.connected)
				assert.strictEqual(status.externalUserEmail, "owner@example.com")
				// One entry per PROPERTY, not per dataset row.
				assert.strictEqual(status.properties.length, 1)
				assert.strictEqual(status.properties[0]?.propertyId, PROPERTY_ID)
				assert.strictEqual(status.properties[0]?.timeZone, "UTC")
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)

	it.effect("clears all collector state on reset", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const fetchOptions = options([new Map([[HOUR, 10]])])

			yield* Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection
				const service = yield* GoogleAnalyticsService
				yield* service.pollOrg(ORG)
				yield* service.resetOrgState(ORG)

				const database = yield* Database
				const rows = yield* database.execute((db) =>
					db.select().from(googleAnalyticsState).where(eq(googleAnalyticsState.orgId, ORG)),
				)
				assert.strictEqual(rows.length, 0)
			}).pipe(Effect.provide(makeLayer(testDb, fetchOptions)))
		}),
	)
})
