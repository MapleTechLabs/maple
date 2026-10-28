/**
 * api → maple-ai over the real service binding, both Workers running locally in workerd
 * through alchemy's dev providers (no cloud deploy). The unit suite stubs the binding;
 * this is the one place the forward runs against the AI Worker that actually ships.
 */
import { expect } from "@effect/vitest"
import { existsSync } from "node:fs"
import path from "node:path"
import * as Alchemy from "alchemy"
import * as Secrets from "alchemy/Secrets"
import * as Test from "alchemy/Test/Vitest"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { createMapleAwsOidcKey } from "@maple/infra/aws"
import {
	AiWorker,
	createMapleDeviceTokenKey,
	ManagedMapleDb,
	MapleStack,
	type MapleStackContext,
	parseMapleDeploymentEffect,
	resolveMapleDomains,
	resolveMapleProfile,
} from "@maple/infra/cloudflare"
import MapleAiLive, { MapleAi } from "../../apps/ai/src/worker.ts"
import MapleApi from "../../apps/api/src/worker.ts"

/** `MapleStackLive` from alchemy.run.ts for a dev stage, minus portless and the declared DB. */
const TestMapleStack = Layer.effect(
	MapleStack,
	Effect.gen(function* () {
		const deployment = yield* parseMapleDeploymentEffect(yield* Alchemy.Stage).pipe(Effect.orDie)
		const context: MapleStackContext = {
			...deployment,
			domains: resolveMapleDomains(deployment),
			profile: resolveMapleProfile(deployment),
			urls: { api: "", ingest: "", electricSync: "" },
			workerDev: () => undefined,
			devEnv: undefined,
			db: undefined,
			awsOidc: yield* createMapleAwsOidcKey(),
			deviceToken: yield* createMapleDeviceTokenKey(),
		}
		return context
	}),
)

// `bun dev`'s env file when present (mise exports it to the shell, a plain one does not).
const envFile = path.join(import.meta.dirname, "../../.env.local")

const Stack = Alchemy.Stack(
	"maple-ai-forward",
	{
		providers: Cloudflare.providers(),
		state: Alchemy.localState(),
		secrets: existsSync(envFile) ? [Secrets.DotEnv({ path: envFile })] : undefined,
	},
	Effect.gen(function* () {
		// Same order as alchemy.run.ts: the DB URL is read outside any Worker init.
		yield* ManagedMapleDb
		const ai = yield* Effect.provide(MapleAi, MapleAiLive)
		const api = yield* Effect.provideService(MapleApi, AiWorker, ai)
		return { apiUrl: api.url }
	}).pipe(Effect.provide(TestMapleStack)),
)

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
	providers: Cloudflare.providers(),
	dev: true,
})

const stack = beforeAll(deploy(Stack), { timeout: 300_000 })
afterAll(destroy(Stack), { timeout: 120_000 })

test(
	"api answers /health itself",
	Effect.gen(function* () {
		const { apiUrl } = yield* stack
		const response = yield* Test.getWhenReady(`${apiUrl}/health`, { times: 3 })
		expect(response.status).toBe(200)
		expect(yield* response.text).toBe("OK")
	}),
)

test(
	"an unauthenticated /mcp call is answered by maple-ai through the binding",
	Effect.gen(function* () {
		const { apiUrl } = yield* stack
		const response = yield* Test.executeWhenReady(
			HttpClientRequest.post(`${apiUrl}/mcp`).pipe(
				HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			),
			// Few retries: a 503 here is more often maple-ai failing than the edge warming up.
			{ times: 3 },
		)
		// api has no /mcp route; a broken binding is its 503, not maple-ai's challenge.
		expect(response.status).toBe(401)
		expect(response.headers["www-authenticate"]).toContain('scope="mcp:tools"')
	}),
)
