import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	ScrapeTargetEncryptionError,
	ScrapeTargetId,
	ScrapeTargetNotFoundError,
	ScrapeTargetStoredConfigInvalidError,
	UserId,
} from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { ApiAuthorizationV2Layer } from "@maple/backend/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import {
	PLANETSCALE_CALLBACK_PATH,
	PlanetScaleOAuthService,
	type PlanetScaleOAuthServiceApi,
} from "@maple/backend/services/auth/PlanetScaleOAuthService"
import {
	PlanetScaleConnectionService,
	type PlanetScaleConnectionServiceApi,
} from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import {
	PlanetScaleService,
	type PlanetScaleServiceApi,
} from "@maple/backend/services/integrations/PlanetScaleService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * End-to-end HTTP tests for the `planetscaleIntegration` v2 group: a real router
 * (auth middleware, admin gate, v2 error envelopes) over an embedded PGlite,
 * with hand-built service fakes so each service error tag can be pinned to the
 * status it must map to.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

/**
 * The API and the web app sit on sibling hosts of one registrable domain in
 * every real deployment; `isTrustedCallbackOrigin` is what enforces that, so
 * the harness mirrors it (`api.maple.test` / `app.maple.test`).
 */
const APP_BASE_URL = "https://app.maple.test"
const API_HOST = "api.maple.test"

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: APP_BASE_URL,
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const psDie = () => Effect.die(new Error("This PlanetScale service method is not stubbed in this test"))

interface PlanetScaleFakes {
	readonly connection?: Partial<PlanetScaleConnectionServiceApi>
	readonly oauth?: Partial<PlanetScaleOAuthServiceApi>
	readonly inventory?: Partial<PlanetScaleServiceApi>
}

/**
 * The three PlanetScale services the v2 group depends on, stubbed so that
 * unstubbed methods die loudly. The edge cache is real (in-memory):
 * `query_insights` and `events` round-trip their responses through it, so a
 * no-op cache would skip the encode the wire shape depends on.
 */
const planetscaleServiceLayer = (fakes: PlanetScaleFakes) =>
	Layer.mergeAll(
		Layer.succeed(PlanetScaleConnectionService, {
			getStatus: psDie,
			finalizeOrgSelection: psDie,
			setMetricsToken: psDie,
			disconnect: psDie,
			loadConnection: psDie,
			webhookConfig: psDie,
			...fakes.connection,
		}),
		Layer.succeed(PlanetScaleOAuthService, {
			startConnect: psDie,
			completeConnect: psDie,
			getValidAccessToken: psDie,
			listOrganizations: psDie,
			hasConnection: psDie,
			connectedByUserId: psDie,
			grantStatus: psDie,
			disconnect: psDie,
			...fakes.oauth,
		}),
		Layer.succeed(PlanetScaleService, {
			pollAllOrgs: psDie,
			listDatabases: psDie,
			listEvents: psDie,
			queryInsights: psDie,
			...fakes.inventory,
		}),
		EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
	)

const makeHarness = (planetscale: PlanetScaleFakes = {}) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(planetscaleServiceLayer(planetscale)),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_integrations_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_integrations_e2e")

	/** Root-role key (API keys resolve as `root` unless their metadata pins roles). */
	const bootstrapAdminKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "integrations-admin", scopes })
			}),
		)

	/** A caller with a real, non-admin role — same shape the CLI login flow issues. */
	const bootstrapMemberKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "integrations-member",
					metadataJson: { source: "maple_cli", roles: ["org:member"], deviceName: "laptop" },
				})
			}),
		)

	const request = async (
		method: string,
		path: string,
		token: string,
		options: { forwardedHost?: string; body?: unknown } = {},
	) => {
		const response = await handler(
			new Request(`http://${API_HOST}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					// `resolveRequestOrigin` prefers x-forwarded-host; set it explicitly
					// so the resolved origin does not depend on the web adapter's
					// host-header handling.
					"x-forwarded-host": options.forwardedHost ?? API_HOST,
					...(!(options.body === undefined) ? { "content-type": "application/json" } : undefined),
				},
				...(!(options.body === undefined) ? { body: JSON.stringify(options.body) } : undefined),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		bootstrapAdminKey,
		bootstrapMemberKey,
		request,
		ORG,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

/**
 * The `planetscaleIntegration` group. Promoted from v1 for scripted setups, so
 * the cases that matter most are the ones a v1 caller could not exercise: scope
 * enforcement, the admin gate as a v2 envelope, and the wire shape a script
 * parses.
 */
describe("v2 planetscale integration over HTTP", () => {
	const connectedStatus = {
		connected: true,
		pendingOrgSelection: false,
		organization: "acme",
		connectedByUserId: null,
		detectedPermissions: { readMetricsEndpoints: true },
		metricsAuth: "service_token" as const,
		scrapeTarget: {
			id: Schema.decodeUnknownSync(ScrapeTargetId)("11111111-1111-4111-8111-111111111111"),
			enabled: true,
			scrapeIntervalSeconds: 60,
			includeBranches: ["main"],
			excludeBranches: ["pr-*"],
			lastScrapeAt: Date.parse("2026-08-05T12:00:00.000Z"),
			lastScrapeError: null,
		},
		lastInventoryAt: Date.parse("2026-08-05T11:00:00.000Z"),
		lastInventoryError: null,
		revokedAt: null,
		expiresAt: null,
	}

	it("returns the status in v2 wire shape, with an ISO scrape time and a scrp_ ID", async () => {
		const harness = makeHarness({ connection: { getStatus: () => Effect.succeed(connectedStatus) } })
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/planetscale", key.secret)
		expect(status).toBe(200)
		expect(body).toMatchObject({
			object: "planetscale_integration",
			connected: true,
			pending_org_selection: false,
			organization: "acme",
			metrics_auth: "service_token",
			last_inventory_at: "2026-08-05T11:00:00.000Z",
			scrape_target: {
				object: "planetscale_integration.scrape_target",
				scrape_interval_seconds: 60,
				include_branches: ["main"],
				exclude_branches: ["pr-*"],
				last_scrape_at: "2026-08-05T12:00:00.000Z",
			},
		})
		// Public ID, not the raw UUID, and no camelCase leakage from the service.
		expect(body.scrape_target.id).toMatch(/^scrp_/)
		expect("metricsAuth" in body).toBe(false)
		await harness.dispose()
	})

	it("preserves a malformed managed-target tag on status", async () => {
		const harness = makeHarness({
			connection: {
				getStatus: () =>
					Effect.fail(
						new ScrapeTargetStoredConfigInvalidError({
							rawTargetId: "broken-target",
							component: "discovery_config",
							message: "stored discovery config is malformed",
							cause: new Error("organization is missing"),
						}),
					),
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/planetscale", key.secret)
		expect(status).toBe(502)
		expect(body.error).toMatchObject({
			_tag: "@maple/http/errors/ScrapeTargetStoredConfigInvalidError",
			code: "scrape_target_stored_config_invalid",
			retryable: false,
			recovery: "reconnect",
		})
		expect(JSON.stringify(body)).not.toContain("organization is missing")
		await harness.dispose()
	})

	it("attaches a metrics token for an admin and answers with the refreshed status", async () => {
		let received: { tokenId: string; tokenSecret: string } | null = null
		const harness = makeHarness({
			connection: {
				setMetricsToken: (_orgId, request) => {
					received = { tokenId: request.tokenId, tokenSecret: request.tokenSecret }
					return Effect.succeed(connectedStatus)
				},
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			key.secret,
			{ body: { token_id: "tok_1", token_secret: "pscale_tkn_secret" } },
		)
		expect(status).toBe(200)
		expect(body.metrics_auth).toBe("service_token")
		// snake_case on the wire, camelCase into the service.
		expect(received).toEqual({ tokenId: "tok_1", tokenSecret: "pscale_tkn_secret" })
		await harness.dispose()
	})

	it("rejects a token PlanetScale refuses with 400 and never reports success", async () => {
		const harness = makeHarness({
			connection: {
				setMetricsToken: () =>
					Effect.fail(
						new IntegrationsValidationError({
							message: "PlanetScale rejected the service token for the metrics endpoint.",
						}),
					),
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			key.secret,
			{ body: { token_id: "tok_bad", token_secret: "nope" } },
		)
		expect(status).toBe(400)
		expect(body.error).toMatchObject({
			type: "invalid_request_error",
			code: "integration_request_invalid",
		})
		await harness.dispose()
	})

	it("preserves a managed scrape-target encryption failure", async () => {
		const harness = makeHarness({
			connection: {
				setMetricsToken: () =>
					Effect.fail(
						new ScrapeTargetEncryptionError({
							message: "failed to encrypt token with key material",
						}),
					),
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			key.secret,
			{ body: { token_id: "tok_1", token_secret: "pscale_tkn_secret" } },
		)

		expect(status).toBe(500)
		expect(body.error).toMatchObject({
			_tag: "@maple/http/errors/ScrapeTargetEncryptionError",
			code: "scrape_target_encryption_failed",
		})
		expect(JSON.stringify(body)).not.toContain("key material")
		await harness.dispose()
	})

	it("preserves a missing managed scrape target as an exact 404", async () => {
		const harness = makeHarness({
			connection: {
				setMetricsToken: () =>
					Effect.fail(
						new ScrapeTargetNotFoundError({
							targetId: connectedStatus.scrapeTarget.id,
							message: "The managed PlanetScale scrape target no longer exists",
						}),
					),
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			key.secret,
			{ body: { token_id: "tok_1", token_secret: "pscale_tkn_secret" } },
		)

		expect(status).toBe(404)
		expect(body.error).toMatchObject({
			_tag: "@maple/http/errors/ScrapeTargetNotFoundError",
			code: "scrape_target_not_found",
			param: "id",
		})
		await harness.dispose()
	})

	it("rejects an empty token id at the schema boundary, before the service is reached", async () => {
		const harness = makeHarness({})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			key.secret,
			{ body: { token_id: "", token_secret: "pscale_tkn_secret" } },
		)
		expect(status).toBe(400)
		expect(body.error.type).toBe("invalid_request_error")
		// The service is `psDie` here: reaching it would crash rather than 400.
		await harness.dispose()
	})

	it("refuses a metrics token from a non-admin member with 403 and never calls the service", async () => {
		const harness = makeHarness({})
		const member = await harness.bootstrapMemberKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			member.secret,
			{ body: { token_id: "tok_1", token_secret: "pscale_tkn_secret" } },
		)
		expect(status).toBe(403)
		expect(body.error).toMatchObject({
			type: "permission_error",
			code: "insufficient_permissions",
		})
		await harness.dispose()
	})

	it("serves the status to a non-admin member — the integration card renders for everyone", async () => {
		const harness = makeHarness({ connection: { getStatus: () => Effect.succeed(connectedStatus) } })
		const member = await harness.bootstrapMemberKey()

		const { status } = await harness.request("GET", "/v2/integrations/planetscale", member.secret)
		expect(status).toBe(200)
		await harness.dispose()
	})

	it("maps a missing connection to 409 and an upstream failure to 502", async () => {
		const notConnected = makeHarness({
			connection: {
				setMetricsToken: () =>
					Effect.fail(
						new IntegrationsNotConnectedError({
							message: "Connect PlanetScale before adding a metrics service token",
						}),
					),
			},
		})
		const notConnectedKey = await notConnected.bootstrapAdminKey()
		const missing = await notConnected.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			notConnectedKey.secret,
			{ body: { token_id: "tok_1", token_secret: "pscale_tkn_secret" } },
		)
		expect(missing.status).toBe(409)
		expect(missing.body.error).toMatchObject({
			_tag: "@maple/http/errors/IntegrationsNotConnectedError",
			code: "integration_not_connected",
		})
		await notConnected.dispose()

		const upstream = makeHarness({
			oauth: {
				listOrganizations: () =>
					Effect.fail(new IntegrationsUpstreamError({ message: "PlanetScale is unavailable" })),
			},
		})
		const upstreamKey = await upstream.bootstrapAdminKey()
		const failed = await upstream.request(
			"GET",
			"/v2/integrations/planetscale/organizations",
			upstreamKey.secret,
		)
		expect(failed.status).toBe(502)
		expect(failed.body.error.code).toBe("integration_upstream_error")
		await upstream.dispose()
	})

	it("fails a connect closed with 503 when the request origin is not trusted", async () => {
		const harness = makeHarness({})
		const key = await harness.bootstrapAdminKey()

		const { status } = await harness.request("POST", "/v2/integrations/planetscale/connect", key.secret, {
			forwardedHost: "evil.example.com",
			body: {},
		})
		// `psDie` would crash if the handler got past the origin gate.
		expect(status).toBe(503)
		await harness.dispose()
	})

	it("mints an authorize URL pointing at the v1 callback path, which did not move", async () => {
		let callbackUrl: string | null = null
		const harness = makeHarness({
			oauth: {
				startConnect: (_orgId, _userId, options) => {
					callbackUrl = options.callbackUrl
					return Effect.succeed({
						redirectUrl: "https://app.planetscale.com/oauth/authorize?state=abc",
						state: "abc",
					})
				},
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/connect",
			key.secret,
			{ body: { return_to: "/integrations" } },
		)
		expect(status).toBe(200)
		expect(body).toEqual({
			object: "planetscale_integration.connect",
			redirect_url: "https://app.planetscale.com/oauth/authorize?state=abc",
			state: "abc",
		})
		expect(callbackUrl).toBe(`https://${API_HOST}${PLANETSCALE_CALLBACK_PATH}`)
		await harness.dispose()
	})

	it("treats query_insights and events as reads: an integrations:read key is enough", async () => {
		const harness = makeHarness({
			inventory: {
				queryInsights: () =>
					Effect.succeed({
						branch: "main",
						rows: [],
						unavailableReason: null,
					}),
				listEvents: () => Effect.succeed({ events: [], nextCursor: null }),
			},
		})
		const readOnly = await harness.bootstrapAdminKey(["integrations:read"])
		const window = {
			start_time: "2026-08-05T11:00:00.000Z",
			end_time: "2026-08-05T12:00:00.000Z",
		}

		const insights = await harness.request(
			"POST",
			"/v2/integrations/planetscale/query_insights",
			readOnly.secret,
			{ body: { database: "acme-prod", ...window } },
		)
		expect(insights.status).toBe(200)
		expect(insights.body).toEqual({
			object: "planetscale_integration.query_insight_list",
			branch: "main",
			data: [],
			unavailable_reason: null,
		})

		const events = await harness.request("POST", "/v2/integrations/planetscale/events", readOnly.secret, {
			body: window,
		})
		expect(events.status).toBe(200)
		expect(events.body).toEqual({
			object: "planetscale_integration.event_list",
			data: [],
			next_cursor: null,
		})

		// The same key must not be able to write.
		const write = await harness.request(
			"POST",
			"/v2/integrations/planetscale/metrics_token",
			readOnly.secret,
			{ body: { token_id: "tok_1", token_secret: "pscale_tkn_secret" } },
		)
		expect(write.status).toBe(403)
		expect(write.body.error.code).toBe("insufficient_scope")
		await harness.dispose()
	})

	it("never puts a persistence failure's message in the public body", async () => {
		// postgres.js puts the whole failing SQL in the error message, so echoing
		// it — which is what the v1 body does — publishes the schema. Found by
		// calling the endpoint against a database missing the events table.
		const harness = makeHarness({
			inventory: {
				listEvents: () =>
					Effect.fail(
						new IntegrationsPersistenceError({
							message:
								'Failed query: select "id", "org_id" from "planetscale_events" [caused by: relation "planetscale_events" does not exist]',
						}),
					),
			},
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/events",
			key.secret,
			{ body: { start_time: "2026-08-05T11:00:00.000Z", end_time: "2026-08-05T12:00:00.000Z" } },
		)
		expect(status).toBe(503)
		expect(body.error.code).toBe("integration_persistence_unavailable")
		const serialized = JSON.stringify(body)
		expect(serialized).not.toContain("select")
		expect(serialized).not.toContain("planetscale_events")
		await harness.dispose()
	})

	it("rejects an inverted window with 400 and names the offending field", async () => {
		const harness = makeHarness({})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/planetscale/events",
			key.secret,
			{ body: { start_time: "2026-08-05T12:00:00.000Z", end_time: "2026-08-05T11:00:00.000Z" } },
		)
		expect(status).toBe(400)
		expect(body.error).toMatchObject({ code: "invalid_time_range", param: "end_time" })
		await harness.dispose()
	})
})
