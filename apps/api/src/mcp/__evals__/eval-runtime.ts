import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { MainLive } from "@/app"
import { Env } from "@/lib/Env"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { WorkerEnvironment } from "@/lib/WorkerEnvironment"
import { cleanupTempDirs, createTempDbUrl } from "@/lib/test-sqlite"
import { mapleToolDefinitions } from "@/mcp/tools/registry"
import { FIXTURES } from "./utils"

const INTERNAL_TOKEN = "eval-internal-token"

const testEnv = (dbUrl: string): Record<string, string> => ({
	PORT: "3472",
	TINYBIRD_HOST: "https://maple-eval.tinybird.co",
	TINYBIRD_TOKEN: "eval-token",
	MAPLE_DB_URL: dbUrl,
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "eval-root-password",
	MAPLE_DEFAULT_ORG_ID: FIXTURES.orgId,
	INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "eval-lookup-key",
	MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
	MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
})

export interface EvalRuntime {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly runtime: ManagedRuntime.ManagedRuntime<any, never>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly requestLayer: Layer.Layer<any>
	readonly dispose: () => Promise<void>
}

/**
 * Build a node runtime for the app services backed by a temp libsql DB + test
 * config (mirrors apps/api `getMapleAgentSetup`/buildSetup, swapping D1→libsql).
 * The warehouse client must be faked separately via `installFakeWarehouse` —
 * this runtime uses the REAL WarehouseQueryService. The returned `requestLayer`
 * carries an internal-service-token request so tool handlers resolve the tenant
 * without exercising Clerk/API-key auth.
 */
export const makeEvalRuntime = (): EvalRuntime => {
	const tempDirs: string[] = []
	const { url } = createTempDbUrl("maple-eval-", tempDirs)
	const env = testEnv(url)

	const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = DatabaseLibsqlLive.pipe(Layer.provide(envLive))
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const workerEnvLive = Layer.succeed(WorkerEnvironment, env as Record<string, any>)

	const layer = MainLive.pipe(
		Layer.provide(Layer.mergeAll(configLive, envLive, databaseLive, workerEnvLive)),
	)
	// `as any`: the residual requirement set is satisfied at runtime (same pattern
	// as apps/api/src/agent.ts buildSetup).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const runtime = ManagedRuntime.make(layer as any) as ManagedRuntime.ManagedRuntime<any, never>

	const requestLayer = Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(
			new Request("https://maple.eval/mcp", {
				headers: {
					Authorization: `Bearer maple_svc_${INTERNAL_TOKEN}`,
					"X-Org-Id": FIXTURES.orgId,
				},
			}),
		),
	)

	return {
		runtime,
		requestLayer,
		dispose: async () => {
			await runtime.dispose()
			cleanupTempDirs(tempDirs)
		},
	}
}

/**
 * Invoke a tool handler directly (no LLM) through the eval runtime + request
 * layer. Used to validate the full-execution wiring without spending an LLM call.
 */
export const runToolDirect = async (
	rt: EvalRuntime,
	name: string,
	params: unknown,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
	const definition = mapleToolDefinitions.find((d) => d.name === name)
	if (!definition) throw new Error(`unknown tool: ${name}`)
	const decoded = Schema.decodeUnknownSync(definition.schema)(params)
	return rt.runtime.runPromise(definition.handler(decoded).pipe(Effect.provide(rt.requestLayer)))
}
