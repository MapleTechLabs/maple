import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import type { RateLimiterApi } from "@/services/auth/ApiV2RateLimiter"
import { McpToolRateLimiter } from "@/services/auth/McpToolRateLimiter"
import { McpToolExecutor, type McpToolExecutorApi } from "./dispatcher"
import { McpLive } from "./app"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeMcpToolExecutorStubLayer = (
	execute: McpToolExecutorApi["execute"] = () =>
		Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }),
) => Layer.succeed(McpToolExecutor, { execute })

const makeRateLimiterStubLayer = (
	check: RateLimiterApi["check"] = () => Effect.succeed("allowed" as const),
) => Layer.succeed(McpToolRateLimiter, { check })

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

describe("MCP HTTP authorization", () => {
	it("challenges unauthenticated clients before MCP initialization", async () => {
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer(),
			makeRateLimiterStubLayer(),
		).pipe(Layer.provideMerge(base))
		const routes = McpLive.pipe(Layer.provideMerge(services))
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		try {
			const response = await handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						host: "api.example.com",
						"x-forwarded-proto": "https",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			expect(response.status).toBe(401)
			expect(response.headers.get("www-authenticate")).toContain(
				'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
			)
			expect(response.headers.get("www-authenticate")).toContain('scope="mcp:tools"')
		} finally {
			await dispose()
		}
	})

	it("accepts an audience-bound OAuth key behind a forwarded HTTPS proxy", async () => {
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		let executedOrgId: string | undefined
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer((tenant) => {
				executedOrgId = tenant.orgId
				return Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] })
			}),
			makeRateLimiterStubLayer(),
		).pipe(Layer.provideMerge(base))
		const orgId = Schema.decodeUnknownSync(OrgId)("org_test")
		const userId = Schema.decodeUnknownSync(UserId)("user_test")
		const key = await Effect.runPromise(
			Effect.gen(function* () {
				const apiKeys = yield* ApiKeysService
				return yield* apiKeys.create(orgId, userId, {
					name: "OAuth MCP test",
					kind: "mcp",
					scopes: ["mcp:tools"],
					metadataJson: {
						source: "maple_mcp_oauth",
						roles: ["org:member"],
						clientId: "client_test",
						resource: "https://api.example.com/mcp",
					},
				})
			}).pipe(Effect.provide(services)),
		)
		const routes = McpLive.pipe(Layer.provideMerge(services))
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		try {
			const response = await handler(
				new Request("http://internal-worker.invalid/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "internal-worker.invalid",
						"x-forwarded-host": "api.example.com",
						"x-forwarded-proto": "https",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			expect(response.status).toBe(200)

			// Stateless: no session id is issued, and the follow-ups below need none.
			expect(response.headers.get("mcp-session-id")).toBeNull()
			await handler(
				new Request("http://internal-worker.invalid/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "internal-worker.invalid",
						"x-forwarded-host": "api.example.com",
						"x-forwarded-proto": "https",
						"mcp-protocol-version": "2025-06-18",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/initialized",
					}),
				}),
				Context.empty() as never,
			)
			const called = await handler(
				new Request("http://internal-worker.invalid/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "internal-worker.invalid",
						"x-forwarded-host": "api.example.com",
						"x-forwarded-proto": "https",
						"mcp-protocol-version": "2025-06-18",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "inspect_trace", arguments: {} },
					}),
				}),
				Context.empty() as never,
			)
			const calledBody = await called.clone().text()
			expect({ status: called.status, body: calledBody }).toEqual({
				status: 200,
				body: expect.any(String),
			})
			expect(executedOrgId).toBe(orgId)
		} finally {
			await dispose()
		}
	})

	it("negotiates a newer client protocol version down instead of rejecting it", async () => {
		// Regression: the Slack agent's MCP client advertises `2025-11-25` in the
		// `Mcp-Protocol-Version` header on the very first `initialize` request —
		// where per the MCP spec that header is only the client's preference and
		// negotiation belongs in the body. McpServer rejected it with a bare 400
		// before parsing the body — and eve reads 400 as "wrong transport", retries
		// over SSE, and gets 405 from a POST-only route. The bot never connected once.
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer(),
			makeRateLimiterStubLayer(),
		).pipe(Layer.provideMerge(base))
		const orgId = Schema.decodeUnknownSync(OrgId)("org_test")
		const userId = Schema.decodeUnknownSync(UserId)("user_test")
		const key = await Effect.runPromise(
			Effect.gen(function* () {
				const apiKeys = yield* ApiKeysService
				return yield* apiKeys.create(orgId, userId, { name: "Newer protocol test", kind: "mcp" })
			}).pipe(Effect.provide(services)),
		)
		const routes = McpLive.pipe(Layer.provideMerge(services))
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		const headers = (extra: Record<string, string> = {}) => ({
			authorization: `Bearer ${key.secret}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			host: "api.example.com",
			"x-forwarded-proto": "https",
			"mcp-protocol-version": "2025-11-25",
			...extra,
		})
		try {
			const initialized = await handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			const initializedBody = await initialized.clone().json()
			expect({
				status: initialized.status,
				protocolVersion: initializedBody.result?.protocolVersion,
			}).toEqual({
				status: 200,
				protocolVersion: "2025-06-18",
			})

			// The client keeps sending its own version on follow-ups, and the
			// transport issues no session id to send back with it.
			const called = await handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "inspect_trace", arguments: {} },
					}),
				}),
				Context.empty() as never,
			)
			expect(called.status).toBe(200)
		} finally {
			await dispose()
		}
	})
	it("serves every request without prior session state", async () => {
		// Regression: Effect's HTTP transport pins each negotiated session to a map
		// created per layer build — per isolate on Workers — and answers a session id
		// it did not issue with a bare 404. Every call after `initialize` therefore
		// failed whenever it landed on another isolate, which in production was about
		// half of them. Maple's transport is stateless: it issues no session id, and
		// serves a request that carries a stale one anyway.
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer(),
			makeRateLimiterStubLayer(),
		).pipe(Layer.provideMerge(base))
		const orgId = Schema.decodeUnknownSync(OrgId)("org_test")
		const userId = Schema.decodeUnknownSync(UserId)("user_test")
		const key = await Effect.runPromise(
			Effect.gen(function* () {
				const apiKeys = yield* ApiKeysService
				return yield* apiKeys.create(orgId, userId, { name: "Stateless test", kind: "mcp" })
			}).pipe(Effect.provide(services)),
		)
		const headers = (extra: Record<string, string> = {}) => ({
			authorization: `Bearer ${key.secret}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			host: "api.example.com",
			"x-forwarded-proto": "https",
			...extra,
		})

		const first = HttpRouter.toWebHandler(McpLive.pipe(Layer.provideMerge(services)), {
			disableLogger: true,
		})
		try {
			const initialized = await first.handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			// No session id on the wire is what keeps clients off the 404 branch.
			expect({
				status: initialized.status,
				sessionId: initialized.headers.get("mcp-session-id"),
			}).toEqual({ status: 200, sessionId: null })
		} finally {
			await first.dispose()
		}

		// A build that never saw the handshake above, as the next isolate would not.
		const second = HttpRouter.toWebHandler(McpLive.pipe(Layer.provideMerge(services)), {
			disableLogger: true,
		})
		try {
			const listed = await second.handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: headers({ "mcp-protocol-version": "2025-06-18" }),
					body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
				}),
				Context.empty() as never,
			)
			const body = await listed.clone().text()
			expect({ status: listed.status, defect: body.includes("A defect occurred") }).toEqual({
				status: 200,
				defect: false,
			})
			expect(body).toContain("inspect_trace")

			// A session id left over from an earlier isolate is ignored, not rejected.
			const stale = await second.handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: headers({
						"mcp-session-id": "00000000-0000-4000-8000-000000000000",
						"mcp-protocol-version": "2025-06-18",
					}),
					body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
				}),
				Context.empty() as never,
			)
			expect(stale.status).toBe(200)
		} finally {
			await second.dispose()
		}
	})

	it("refuses an over-budget credential with 429 and Retry-After", async () => {
		const db = createTestDb(createdDbs)
		const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
		const limitedKeys: string[] = []
		let executed = false
		const services = Layer.mergeAll(
			ApiKeysService.layer,
			AuthService.layer,
			makeMcpToolExecutorStubLayer(() => {
				executed = true
				return Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] })
			}),
			makeRateLimiterStubLayer((key) => {
				limitedKeys.push(key)
				return Effect.succeed("limited" as const)
			}),
		).pipe(Layer.provideMerge(base))
		const orgId = Schema.decodeUnknownSync(OrgId)("org_test")
		const userId = Schema.decodeUnknownSync(UserId)("user_test")
		const key = await Effect.runPromise(
			Effect.gen(function* () {
				const apiKeys = yield* ApiKeysService
				return yield* apiKeys.create(orgId, userId, { name: "Rate limit test", kind: "mcp" })
			}).pipe(Effect.provide(services)),
		)
		const routes = McpLive.pipe(Layer.provideMerge(services))
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		try {
			const response = await handler(
				new Request("https://api.example.com/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${key.secret}`,
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
						host: "api.example.com",
						"x-forwarded-proto": "https",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "test", version: "1.0.0" },
						},
					}),
				}),
				Context.empty() as never,
			)
			const body = await response.clone().json()
			expect({
				status: response.status,
				retryAfter: response.headers.get("retry-after"),
				error: body.error,
				executed,
			}).toEqual({ status: 429, retryAfter: "10", error: "rate_limited", executed: false })
			// Buckets are per internal key id, so a rolled key gets a fresh budget
			// and the raw secret never reaches the counter key.
			expect(limitedKeys).toEqual([`key:${key.id}`])
		} finally {
			await dispose()
		}
	})
})
