import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, PortableDashboardDocument, UserId } from "@maple/domain/http"
import { makeMaplePgliteDb } from "@maple/db/pglite"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { MapleDbConnection } from "@maple/backend/platform/bindings"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { Env } from "@maple/backend/platform/Env"
import {
	makePgConnectionScope,
	type PgConnectionScopeApi,
	withPgConnectionScopeOf,
} from "@maple/backend/platform/pg-connection-scope"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { McpToolRateLimiter } from "@maple/backend/services/auth/McpToolRateLimiter"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { buildIsolateHandler } from "../worker/http"
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

const ORG = Schema.decodeSync(OrgId)("org_scope")
const USER = Schema.decodeSync(UserId)("user_scope")

const ToolCallBody = Schema.Struct({
	result: Schema.Struct({
		isError: Schema.optionalKey(Schema.Boolean),
		content: Schema.Array(
			Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
		),
		structuredContent: Schema.optionalKey(
			Schema.Struct({ dashboards: Schema.Array(Schema.Struct({ name: Schema.String })) }),
		),
	}),
})

/**
 * The AI Worker's MCP path on one isolate: the production route builder, the real lazy tool
 * executor and its full service graph, and Postgres reached only through `DatabasePgLive`.
 * Each request gets its own connection scope, opened and closed around it as `makeFetch` does.
 */
const isolate = async () => {
	const db = createTestDb(createdDbs)
	const seeded = await Effect.runPromise(
		Effect.gen(function* () {
			const apiKeys = yield* ApiKeysService
			const key = yield* apiKeys.create(ORG, USER, { name: "Request scope test", kind: "mcp" })
			const dashboards = yield* DashboardPersistenceService
			yield* dashboards.create(
				ORG,
				USER,
				new PortableDashboardDocument({
					name: "Checkout latency",
					timeRange: { type: "relative", value: "12h" },
					widgets: [],
				}),
			)
			return key
		}).pipe(
			Effect.provide(
				Layer.mergeAll(ApiKeysService.layer, DashboardPersistenceService.layer).pipe(
					Layer.provide(Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig)))),
				),
			),
		),
	)

	const ports = Layer.mergeAll(
		Layer.succeed(
			MapleDbConnection,
			Option.some({ connectionString: "postgres://unused.invalid/maple", attributes: {} }),
		),
		Env.layer.pipe(Layer.provide(testConfig)),
	)
	const routes = McpLive.pipe(
		Layer.provideMerge(McpToolExecutorLoader.layer),
		Layer.provideMerge(
			Layer.mergeAll(
				ApiKeysService.layer,
				ErrorActorsService.layer,
				AuthService.layer,
				Layer.succeed(McpToolRateLimiter, { check: () => Effect.succeed("allowed" as const) }),
			),
		),
		Layer.provideMerge(DatabasePgLive),
		Layer.provideMerge(ports),
	)
	const handler = await Effect.runPromise(
		Effect.flatMap(Effect.context<never>(), (context) => buildIsolateHandler(context, routes)),
	)

	// Which request's scope ran each statement.
	const statements: Array<string> = []
	const scopeFor = (label: string): PgConnectionScopeApi => {
		const scope = makePgConnectionScope("postgres://unused.invalid/maple", undefined, {
			openDb: makeMaplePgliteDb(db.pglite),
		})
		return {
			run: (fn) =>
				Effect.andThen(
					Effect.sync(() => statements.push(label)),
					scope.run(fn),
				),
			close: scope.close,
		}
	}

	const callTool = async (label: string, name: string) => {
		const request = new Request("https://api.example.com/mcp", {
			method: "POST",
			headers: {
				authorization: `Bearer ${seeded.secret}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				host: "api.example.com",
				"x-forwarded-proto": "https",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: {} },
			}),
		})
		const response = await Effect.runPromise(
			withPgConnectionScopeOf(scopeFor(label), handler).pipe(
				Effect.map(HttpServerResponse.toWeb),
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(request),
				),
				Effect.scoped,
			),
		)
		return Schema.decodeUnknownSync(ToolCallBody)(await response.json()).result
	}

	return { callTool, statements }
}

describe("MCP tool calls on one isolate", () => {
	it("reads Postgres on every request, not only the one that built the tool graph", async () => {
		const { callTool } = await isolate()

		const first = await callTool("first", "list_dashboards")
		const second = await callTool("second", "list_dashboards")

		const outcome = (result: typeof first) => ({
			isError: result.isError ?? false,
			names: result.structuredContent?.dashboards.map((dashboard) => dashboard.name),
		})
		expect([outcome(first), outcome(second)]).toEqual([
			{ isError: false, names: ["Checkout latency"] },
			{ isError: false, names: ["Checkout latency"] },
		])
	})

	it("runs a tool's statements on the calling request's connection scope", async () => {
		const { callTool, statements } = await isolate()

		await callTool("first", "list_dashboards")
		const afterFirst = statements.length
		await callTool("second", "list_dashboards")

		const secondRequest = statements.slice(afterFirst)
		expect(secondRequest.length).toBeGreaterThan(0)
		expect(new Set(secondRequest)).toEqual(new Set(["second"]))
	})
})
