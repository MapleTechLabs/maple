import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { IngestKeysResponse, IsoDateTimeString, OrgId, UserId } from "@maple/domain/http"
import type { UptimeMonitorId } from "@maple/domain/primitives"
import { UPTIME_CHECK_REPORT_BATCH_MAX } from "@maple/domain/uptime"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { UptimeMonitorAllowance } from "@maple/backend/services/uptime/UptimeMonitorAllowance"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { UptimeHeartbeatRouter, UptimeInternalRouter } from "./uptime-internal.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_uptime_internal")
const USER = Schema.decodeUnknownSync(UserId)("user_uptime_internal")
const asIso = Schema.decodeUnknownSync(IsoDateTimeString)
const die = () => Effect.die(new Error("not used by the uptime routes"))

const ingestKeysStub = Layer.succeed(OrgIngestKeysService, {
	getOrCreate: die,
	getOrCreateMany: (orgIds) =>
		Effect.succeed(
			new Map(
				orgIds.map((orgId) => [
					orgId,
					new IngestKeysResponse({
						publicKey: `maple_pk_${orgId}`,
						privateKey: "maple_sk_unused",
						publicRotatedAt: asIso("2026-01-01T00:00:00.000Z"),
						privateRotatedAt: asIso("2026-01-01T00:00:00.000Z"),
					}),
				]),
			),
		),
	forget: die,
	rerollPublic: die,
	rerollPrivate: die,
	resolveIngestKey: die,
})

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_API_BASE_URL: "https://api.maple.test",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					SD_INTERNAL_TOKEN: "sd-token",
				}),
			),
		),
	)
	const uptimeLive = Layer.effect(UptimeMonitorsService, UptimeMonitorsService.make).pipe(
		Layer.provide(UptimeMonitorAllowance.unmetered),
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(envLive, testDb.layer)),
	)
	const routes = Layer.mergeAll(UptimeInternalRouter, UptimeHeartbeatRouter).pipe(
		Layer.provide(Layer.mergeAll(uptimeLive, ingestKeysStub, envLive)),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(uptimeLive)

	const request = async (method: string, path: string, init: { token?: string; body?: unknown } = {}) => {
		const response = await handler(
			new Request(`http://api.localhost${path}`, {
				method,
				headers: {
					...(init.token === undefined ? undefined : { authorization: `Bearer ${init.token}` }),
					...(init.body === undefined ? undefined : { "content-type": "application/json" }),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, text: await response.text() }
	}

	const run = <A, E>(effect: Effect.Effect<A, E, UptimeMonitorsService>) => runtime.runPromise(effect)

	return {
		request,
		run,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

const createMonitors = Effect.gen(function* () {
	const service = yield* UptimeMonitorsService
	const http = yield* service.create(ORG, {
		name: "API health",
		kind: "http",
		config: {
			_tag: "http",
			url: "https://api.example.com/health",
			method: "GET",
			headers: {},
			assertions: [],
			timeoutMs: 5000,
		},
		failuresToDown: 1,
		createdBy: USER,
	})
	const heartbeat = yield* service.create(ORG, {
		name: "nightly backup",
		kind: "heartbeat",
		config: { _tag: "heartbeat", schedule: { _tag: "interval", seconds: 3600 }, graceSeconds: 60 },
		createdBy: USER,
	})
	const url = heartbeat.heartbeatUrl ?? ""
	return { http, heartbeat, token: url.slice(url.lastIndexOf("/") + 1) }
})

const getMonitor = (id: UptimeMonitorId) =>
	Effect.gen(function* () {
		const service = yield* UptimeMonitorsService
		return yield* service.get(ORG, id)
	})

/** Runs `body` against a fresh harness, disposed however the body ends. */
const withHarness = (body: (harness: ReturnType<typeof makeHarness>) => Promise<void>) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.sync(makeHarness),
			(harness) => Effect.promise(() => body(harness)),
			(harness) => Effect.promise(() => harness.dispose()),
		),
	)

describe("uptime internal routes", () => {
	it("refuses the scraper endpoints without the internal bearer", () =>
		withHarness(async (harness) => {
			expect((await harness.request("GET", "/api/internal/uptime-targets")).status).toBe(401)
			expect(
				(await harness.request("GET", "/api/internal/uptime-targets", { token: "wrong" })).status,
			).toBe(401)
			expect((await harness.request("POST", "/api/internal/uptime-results", { body: [] })).status).toBe(
				401,
			)
		}))

	it("lists probe targets with the org's ingest key and applies reported results", () =>
		withHarness(async (harness) => {
			const { http } = await harness.run(createMonitors)

			const listed = await harness.request("GET", "/api/internal/uptime-targets", { token: "sd-token" })
			expect(listed.status).toBe(200)
			const targets = JSON.parse(listed.text)
			// Heartbeats are pinged by the job itself, never probed.
			expect(targets).toHaveLength(1)
			expect(targets[0]).toMatchObject({
				id: http.id,
				orgId: ORG,
				intervalSeconds: 60,
				ingestKey: `maple_pk_${ORG}`,
				config: { _tag: "http", url: "https://api.example.com/health" },
			})

			const malformed = await harness.request("POST", "/api/internal/uptime-results", {
				token: "sd-token",
				body: [{ monitorId: "nope" }],
			})
			expect(malformed.status).toBe(400)

			// One more report than a batch may hold is refused whole, nothing applied.
			const report = {
				monitorId: http.id,
				checkedAt: 1_600_000_000_000,
				ok: false,
				durationMs: 10,
				statusCode: 503,
				error: "Status 503, expected 2xx",
				traceId: null,
			}
			const oversized = await harness.request("POST", "/api/internal/uptime-results", {
				token: "sd-token",
				body: Array.from({ length: UPTIME_CHECK_REPORT_BATCH_MAX + 1 }, () => report),
			})
			expect(oversized.status).toBe(400)
			expect((await harness.run(getMonitor(http.id))).state.lastCheck).toBeNull()

			const recorded = await harness.request("POST", "/api/internal/uptime-results", {
				token: "sd-token",
				body: [
					{
						monitorId: http.id,
						checkedAt: 1_700_000_000_000,
						ok: false,
						durationMs: 5000,
						statusCode: null,
						error: "Connection timed out",
						traceId: "0af7651916cd43dd8448eb211c80319c",
					},
				],
			})
			expect(recorded.status).toBe(200)
			expect(JSON.parse(recorded.text)).toEqual({ recorded: 1, applied: 1 })

			const state = await harness.run(getMonitor(http.id))
			expect(state.state.status).toBe("down")
			expect(state.state.lastCheck?.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
		}))

	it("records heartbeat pings and fails, and 404s unknown tokens", () =>
		withHarness(async (harness) => {
			const { heartbeat, token } = await harness.run(createMonitors)
			const statusOf = () => harness.run(getMonitor(heartbeat.id))

			const ping = await harness.request("GET", `/hb/${token}`)
			expect(ping).toEqual({ status: 200, text: "OK" })
			expect((await statusOf()).state.status).toBe("up")

			const fail = await harness.request("POST", `/hb/${token}/fail`)
			expect(fail).toEqual({ status: 200, text: "OK" })
			expect((await statusOf()).state.status).toBe("down")

			expect((await harness.request("POST", "/hb/unknown-token-0000000000")).status).toBe(404)
			expect((await harness.request("GET", "/hb/bad!")).status).toBe(404)
		}))
})
