/**
 * The AI Worker in alchemy's single-module form: this file is both the resource
 * the root stack yields (`yield* MapleAi`) and the bundle alchemy deploys
 * (`main: import.meta.url`).
 *
 * Everything Maple's agents do runs here rather than in `apps/api`: the public
 * MCP server and its tools, the chat agent and its Durable Object, and the
 * autonomous investigation fan-out. They moved together because they are one
 * thing wearing three hats — all three reach the same tool registry in-process,
 * so splitting any one of them out alone leaves the registry behind, which is
 * exactly what made the first attempt at this worth 1%.
 *
 * Measured on the api's module graph before the move (rolldown, unminified):
 * dropping the MCP registry, the chat routes and the two hosted classes takes it
 * from 11.74 MB over 85 chunks to 9.34 MB over 50, and module evaluation from
 * ~336 ms to ~278 ms. The other half is per-request: a `/mcp` call no longer
 * builds `AllRoutes` and `ApiAuthLive`, and a `/v2` call no longer builds 47
 * tool schemas.
 *
 * `api.maple.dev/mcp` is still the public address. The api forwards `/mcp` and
 * the chat paths here over a service binding, which keeps the OAuth issuer and
 * the RFC 8707 resource identifiers on api's origin — moving them would
 * invalidate every registered MCP client.
 *
 * Startup-CPU note (Cloudflare error 10021): the 47 tool schemas at module scope
 * are what blew the upload-validation budget once already, so every heavy graph
 * stays behind a dynamic import, exactly as `apps/api/src/worker/modules.ts`
 * documents for the api.
 */
import {
	cachedRecoverable,
	CLOUDFLARE_WORKER_PLACEMENT,
	MapleDb,
	MapleStack,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { appUrlsEnv, authEnv, merge, selfObservabilityEnv, tinybirdEnv } from "@maple/infra/env"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"

/**
 * The AI worker's resource bindings, split from the `Config`-sourced env so
 * `InferEnv` can derive `AiWorkerEnv` below.
 *
 * Empty until the surfaces land: the MCP tool rate limiter arrives with the
 * transport, the AI gateway and the sandbox binding with the tools that use
 * them, and the two hosted classes are yielded in the init rather than declared
 * here.
 */
const makeWorkerBindings = (_: { stage: MapleStage }) => ({})

/**
 * The AI worker's runtime env, derived from the declaration above.
 *
 * `Partial` for the same reason alerting's is: a binding's absence is a real
 * runtime state. Configuration vars stay `unknown` on purpose — config is read
 * through the Effect ConfigProvider, never off `env` directly.
 */
export type AiWorkerEnv = Partial<Cloudflare.InferEnv<ReturnType<typeof makeWorkerBindings>>> &
	Record<string, unknown>

/**
 * Everything in the AI worker's env that comes from configuration rather than
 * from a resource. The agents query the warehouse as the calling org and resolve
 * their own tenants, so this is largely the api's set; the LLM provider keys
 * arrive with `platform/Llm.ts`.
 */
const configuredEnv = (stage: MapleStage) =>
	merge(tinybirdEnv, authEnv, appUrlsEnv, selfObservabilityEnv(stage))

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, workerDev, devEnv } = yield* MapleStack
	const env = yield* configuredEnv(stage)
	return {
		main: import.meta.url,
		name: resolveWorkerName("ai", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Under `bun dev`: a sticky port the app's route follows.
		dev: workerDev("ai"),
		// No public hostname. Reached only over the api's service binding, which is
		// what keeps `/mcp` on api's origin and its OAuth identifiers unchanged.
		workersDev: false,
		// Same override, same reason, as the api's: without it the drizzle and
		// Effect-Schema graph evaluates lazily inside the first Postgres call, which
		// is what turned into CONNECT_TIMEOUTs on 2026-08-08. This worker carries
		// that same graph.
		build: { output: { strictExecutionOrder: false } },
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: { ...makeWorkerBindings({ stage }), ...env, ...devEnv },
	}
})

export default class MapleAi extends Cloudflare.Worker<MapleAi>()(
	"ai",
	props,
	Effect.gen(function* () {
		// `MAPLE_DB` in the stage's flavor. The agents read and write the same
		// application database the api does — investigations, error issues, alert
		// rules — so this is a connection budget of its own, not a share of api's.
		yield* MapleDb("ai")
		// The routes arrive here in the next phase, behind this import: the MCP
		// transport and the chat routes both pull the service graph, which has no
		// business in startup validation or in the deploy process.
		const app = yield* cachedRecoverable(Effect.promise(() => import("./app")))
		return { fetch: (yield* app).fetch }
	}).pipe(
		// The Worker's init IS the entry point: the bridge builds telemetry into
		// each event's scope and flushes it after.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				Cloudflare.Hyperdrive.ConnectBinding,
				WorkerTelemetry({ serviceName: "maple-ai" }),
			),
		),
	),
) {}
