/**
 * The AI Worker in alchemy's single-module form: this file is both the resource
 * the root stack yields (`yield* MapleAi`) and the bundle alchemy deploys
 * (`main: import.meta.url`).
 *
 * Everything Maple's agents do runs here rather than in `apps/api`: the public
 * MCP server and its tools, and the chat agent and its Durable Object, which
 * also runs every investigation's autonomous pass. They moved together because
 * they are one thing wearing two hats — both reach the same tool registry
 * in-process, so splitting either out alone leaves the registry behind, which
 * is exactly what made the first attempt at this worth 1%.
 *
 * Measured on the api's module graph before the move (rolldown, unminified):
 * dropping the MCP registry, the chat routes and the hosted classes takes it
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
	MapleStack,
	type MapleDomains,
	type MapleRegion,
	type MapleStage,
	mapleDbEnv,
	resolveWorkerName,
	resolveWorkerPlacement,
	SandboxWorker,
	stageDeploysSandbox,
} from "@maple/infra/cloudflare"
import {
	appUrlsEnv,
	authEnv,
	githubAppSourceEnv,
	ingestKeyCryptoEnv,
	merge,
	optionalPlain,
	optionalSecret,
	requireSecretEntry,
	selfObservabilityEnv,
	tinybirdEnv,
} from "@maple/infra/env"
import { isolateContext } from "@maple/infra/worker-http"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import { Effect, Layer, Option } from "effect"
import { ChatSessionLive, ChatSessionObject } from "./chat/ChatSession"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "./mcp/expected-failures"
import { aiPorts, AiBindingLayers, bindAiClients } from "./worker/bindings"
import { buildApp, makeFetch } from "./worker/http"
import { AiObservabilityLive } from "./worker/observability"

/**
 * The AI worker's resource bindings, split from the `Config`-sourced env so
 * `InferEnv` can derive `AiWorkerEnv` below.
 *
 * Only the AI gateway: the MCP tool rate limiter is bound in the init, the
 * hosted class is yielded there rather than declared here, and the sandbox
 * Worker is a sibling this deploy creates, so `props` binds it from
 * `SandboxWorker` where a `Worker.ref` could not see it.
 */
const makeWorkerBindings = ({ stage }: { stage: MapleStage }) => ({
	// Workers AI, for the models the agents call. The GATEWAY NAME is api's,
	// unchanged: renaming it mints a new gateway and abandons its logs and
	// analytics. Only the alchemy logical id moved.
	...(stage.kind === "dev" ? undefined : { AI: Cloudflare.AI.Gateway("maple-api-ai") }),
})

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
const configuredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		// The tools query the warehouse as the calling org, and resolve their own
		// tenants, so this is largely the api's set.
		tinybirdEnv,
		authEnv,
		appUrlsEnv(domains),
		selfObservabilityEnv(stage, region),
		ingestKeyCryptoEnv,
		// Agent LLM path. `MAPLE_LLM_PROVIDER` flips between OpenRouter (default) and
		// Workers AI; both stay wired, so a switch is this one var plus a redeploy.
		// See `@/platform/Llm` for the provider-scoped model overrides.
		optionalPlain("MAPLE_LLM_PROVIDER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
		optionalSecret("OPENROUTER_API_KEY"),
		// The decision model (Jev) rides the same OpenRouter key, on OpenRouter's
		// separate decisions endpoint. See `layerDecisionModel` in `@/platform/Llm`.
		optionalPlain("MAPLE_DECISION_MODEL"),
		// The chat agent authenticates to `/mcp` as an internal caller.
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		// The source and sandbox tools resolve a connected repository through the
		// GitHub App, so its reader credentials live here as well as on api. They
		// moved here with the tools (#861) but were left declared on api only,
		// and every sandbox call failed with "GitHub App is not configured".
		githubAppSourceEnv,
		// This Worker's half of the sandbox service binding's auth. Declared only
		// on the stages that deploy a sandbox Worker, and required there: without
		// it the binding is present but every call is refused, which reads to the
		// agent as "no sandbox in this deployment".
		...(stageDeploysSandbox(stage) ? [requireSecretEntry("SANDBOX_INTERNAL_SERVICE_TOKEN")] : []),
		// Dev-only escape hatch from per-org BYO rows (see apps/api/src/resources/env.ts).
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
	)

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, region, domains, workerDev, devEnv, db } = yield* MapleStack
	// The agents' repository sandbox, reached only over this binding. Absent on
	// the stages that do not deploy it, where `SandboxClient` reports the tools
	// as unavailable rather than failing.
	const sandbox = yield* Effect.serviceOption(SandboxWorker)
	const env = yield* configuredEnv(stage, region, domains)
	return {
		main: import.meta.url,
		name: resolveWorkerName("ai", stage, region),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: resolveWorkerPlacement(region),
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
		env: {
			...makeWorkerBindings({ stage }),
			...mapleDbEnv(db, "ai"),
			...(Option.isSome(sandbox) ? { SANDBOX: sandbox.value } : undefined),
			...env,
			...devEnv,
		},
	}
})

export class MapleAi extends Cloudflare.Worker<MapleAi, Cloudflare.WorkerShape, ChatSessionObject>()("ai") {}

export default MapleAi.make(
	props,
	Effect.gen(function* () {
		// The classes this Worker hosts. Yielded here, which is what binds them,
		// registers them at plan time and exports them from the generated entry —
		// never a ref-form binding plus a hand-written class.
		yield* ChatSessionObject
		const clients = yield* bindAiClients
		const env = yield* Cloudflare.WorkerEnvironment
		const ports = aiPorts(clients, env)
		// Captured before any event exists, so a graph built inside the first
		// request cannot leak that request's context into every later one. See
		// `forIsolate`; `isolateContext` says what the capture must not carry.
		const isolate = isolateContext(yield* Effect.context())
		const app = yield* cachedRecoverable(buildApp(isolate, ports))
		return { fetch: makeFetch(app, ports) }
	}).pipe(
		// The Worker's init IS the entry point: the bridge builds telemetry into
		// each event's scope and flushes it after.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				AiBindingLayers,
				// The host Worker's layer also provides the Durable Object's
				// implementation; yielding the class above is what forces this to run,
				// so the class reaches the generated entry's exports.
				ChatSessionLive,
				WorkerTelemetry({
					serviceName: "maple-ai",
					// Both carried over from apps/api with the surfaces they describe.
					// `dropSpanNames` keeps the MCP server's notification spans out of
					// export; the MCP identifiers are what keep an expected 400/401 —
					// a tool call that does not decode, a missing credential — exporting
					// with an `Ok` status and no exception event, per CLAUDE.md's rule
					// that only 5xx is an `Error` span. `chat/turn-runner.ts` passes the
					// same set to its own tracer; this is the public `/mcp` transport's.
					dropSpanNames: ["McpServer/Notifications."],
					anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
				}),
				// The references the bridge's `HttpMiddleware.tracer` reads, built into
				// every event beside the SDK; they cannot live in the app graph.
				AlchemyTelemetry.layer(AiObservabilityLive),
			),
		),
	),
)
