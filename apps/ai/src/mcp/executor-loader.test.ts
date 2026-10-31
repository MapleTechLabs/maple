import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Config, ConfigProvider, Effect, Layer, Ref, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { McpToolRateLimiter } from "@maple/backend/services/auth/McpToolRateLimiter"
import { McpToolExecutor } from "./dispatcher"
import { McpToolExecutorLoader } from "./executor-loader"
import { McpLive } from "./app"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = ConfigProvider.layer(
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

/**
 * A stand-in tool graph that counts its imports and builds. Every import returns the same
 * layer, as the real module's `McpServicesLive` constant does, so memoization matches
 * production. With `failFirstBuild`, the first build fails on a missing config key, the way a
 * misconfigured deploy fails it.
 */
const countingGraph = (options: { readonly failFirstBuild: boolean }) => {
	const imports = Ref.makeUnsafe(0)
	const builds = Ref.makeUnsafe(0)
	const graph = Layer.effect(
		McpToolExecutor,
		Effect.gen(function* () {
			const build = yield* Ref.updateAndGet(builds, (n) => n + 1)
			if (options.failFirstBuild && build === 1) yield* Config.String("MAPLE_TEST_UNSET_KEY")
			return {
				execute: () => Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }),
				prepareRepository: () => Effect.void,
				prepareConnectedRepositories: () => Effect.void,
			}
		}),
	)
	const importGraph = Ref.update(imports, (n) => n + 1).pipe(Effect.as(graph))
	const counts = () => Effect.runSync(Effect.all({ imports: Ref.get(imports), builds: Ref.get(builds) }))
	return { counts, loader: McpToolExecutorLoader.layerFrom(importGraph) }
}

const ToolsListBody = Schema.Struct({
	result: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }),
})
const ErrorBody = Schema.Struct({ error: Schema.String })

/** The public MCP routes over the given loader, and a client holding a valid MCP key. */
const mcpClient = async (loader: ReturnType<typeof McpToolExecutorLoader.layerFrom>) => {
	const db = createTestDb(createdDbs)
	const services = Layer.mergeAll(
		ApiKeysService.layer,
		ErrorActorsService.layer,
		AuthService.layer,
		Layer.succeed(McpToolRateLimiter, { check: () => Effect.succeed("allowed" as const) }),
	).pipe(Layer.provideMerge(Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig)))))
	const key = await Effect.runPromise(
		Effect.gen(function* () {
			const apiKeys = yield* ApiKeysService
			return yield* apiKeys.create(
				Schema.decodeUnknownSync(OrgId)("org_test"),
				Schema.decodeUnknownSync(UserId)("user_test"),
				{ name: "Lazy tools test", kind: "mcp" },
			)
		}).pipe(Effect.provide(services)),
	)
	const routes = McpLive.pipe(Layer.provideMerge(loader), Layer.provideMerge(services))
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const send = (method: string, options: { readonly authorized: boolean }) =>
		handler(
			new Request("https://api.example.com/mcp", {
				method: "POST",
				headers: {
					...(options.authorized ? { authorization: `Bearer ${key.secret}` } : undefined),
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					host: "api.example.com",
					"x-forwarded-proto": "https",
					"mcp-protocol-version": "2025-06-18",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method,
					params:
						method === "initialize"
							? {
									protocolVersion: "2025-06-18",
									capabilities: {},
									clientInfo: { name: "test", version: "1.0.0" },
								}
							: {},
				}),
			}),
		)
	return { send, dispose }
}

describe("McpToolExecutorLoader", () => {
	it("loads the tool graph on the first tools request, once, and never for initialize or a 401", async () => {
		const { counts, loader } = countingGraph({ failFirstBuild: false })
		const { send, dispose } = await mcpClient(loader)
		try {
			const statuses = [
				(await send("initialize", { authorized: false })).status,
				(await send("initialize", { authorized: true })).status,
				(await send("resources/list", { authorized: true })).status,
				(await send("prompts/list", { authorized: true })).status,
			]
			expect({ statuses, ...counts() }).toEqual({
				statuses: [401, 200, 200, 200],
				imports: 0,
				builds: 0,
			})

			const listed = Schema.decodeUnknownSync(ToolsListBody)(
				await (await send("tools/list", { authorized: true })).json(),
			)
			await send("tools/list", { authorized: true })
			expect(listed.result.tools.length).toBeGreaterThan(0)
			expect(counts()).toEqual({ imports: 1, builds: 1 })
		} finally {
			await dispose()
		}
	})

	it("answers 503 when the tool graph fails to build, and the next tools request retries it", async () => {
		const { counts, loader } = countingGraph({ failFirstBuild: true })
		const { send, dispose } = await mcpClient(loader)
		try {
			const failed = await send("tools/list", { authorized: true })
			const failedBody = Schema.decodeUnknownSync(ErrorBody)(await failed.json())
			const retried = await send("tools/list", { authorized: true })
			const listed = Schema.decodeUnknownSync(ToolsListBody)(await retried.json())
			expect({
				statuses: [failed.status, retried.status],
				failedError: failedBody.error,
				cacheControl: failed.headers.get("cache-control"),
				hasTools: listed.result.tools.length > 0,
				...counts(),
			}).toEqual({
				statuses: [503, 200],
				failedError: "service_unavailable",
				cacheControl: "no-store",
				hasTools: true,
				imports: 2,
				builds: 2,
			})
		} finally {
			await dispose()
		}
	})
})
