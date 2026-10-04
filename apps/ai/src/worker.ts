/**
 * The AI Worker (alchemy single-module form): the MCP server, the chat agent and
 * its Durable Object, which share the tool registry in-process. api forwards
 * `/mcp` and chat here so the OAuth issuer and resource ids stay on api's origin.
 * Heavy graphs stay behind dynamic imports (startup CPU limit, error 10021).
 */
import {
	cachedRecoverable,
	mapleDbEnv,
	MapleStack,
	type MapleStackContext,
	mapleWorkerProps,
	SandboxWorker,
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
import { WorkersAiGateway } from "./platform/WorkersAiHttpClient"
import { aiPorts, AiBindingLayers, bindAiClients, WorkersAiGatewayLive } from "./worker/bindings"
import { buildApp, makeFetch } from "./worker/http"
import { AiObservabilityLive } from "./worker/observability"

/** Config-sourced env. The tools query the warehouse as the calling org, so this is largely api's set. */
const configuredEnv = ({ stage, region, domains, profile }: MapleStackContext) =>
	merge(
		tinybirdEnv,
		authEnv,
		appUrlsEnv(domains),
		selfObservabilityEnv(stage, region),
		ingestKeyCryptoEnv,
		// `MAPLE_LLM_PROVIDER` picks OpenRouter (default) or Workers AI (`@/platform/Llm`).
		optionalPlain("MAPLE_LLM_PROVIDER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
		optionalPlain("MAPLE_REVIEW_MODEL_OPENROUTER"),
		optionalSecret("OPENROUTER_API_KEY"),
		// Decision model, on Workers AI via the gateway binding (`layerDecisionModel`).
		optionalPlain("MAPLE_DECISION_MODEL"),
		// The chat agent authenticates to `/mcp` as an internal caller.
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		// The source and sandbox tools resolve repositories through the GitHub App, so
		// they need its reader credentials here too, not only on api.
		githubAppSourceEnv,
		// Required wherever a sandbox Worker deploys: without it every sandbox call is refused.
		...(profile.deploys.sandbox ? [requireSecretEntry("SANDBOX_INTERNAL_SERVICE_TOKEN")] : []),
		// Dev-only escape hatch from per-org BYO rows (see apps/api/src/resources/env.ts).
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
	)

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const { devEnv, db } = stack
	// Absent on stages without a sandbox; `SandboxClient` then reports the tools unavailable.
	const sandbox = yield* Effect.serviceOption(SandboxWorker)
	const env = yield* configuredEnv(stack)
	return {
		main: import.meta.url,
		...mapleWorkerProps("ai", stack),
		// No public hostname: reached only over api's service binding.
		workersDev: false,
		// Same as api: keeps DB graph init off the first Postgres dial (docs/infra.md).
		build: { output: { strictExecutionOrder: false } },
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
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
		// Yielding the hosted DO binds, registers and exports it. Its hosting must not move.
		yield* ChatSessionObject
		const clients = yield* bindAiClients
		const env = yield* Cloudflare.WorkerEnvironment
		const ports = aiPorts(clients, env, yield* WorkersAiGateway)
		// Captured before any event, so the first request's context cannot leak into later ones.
		const isolate = isolateContext(yield* Effect.context())
		const app = yield* cachedRecoverable(buildApp(isolate, ports))
		return { fetch: makeFetch(app, ports) }
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				AiBindingLayers,
				// The DO's implementation. The gateway reaches it through activation, not env.
				ChatSessionLive.pipe(Layer.provide(WorkersAiGatewayLive)),
				WorkerTelemetry({
					serviceName: "maple-ai",
					// Expected MCP 400/401s export as `Ok` (only 5xx is `Error`);
					// `chat/turn-runner.ts` passes the same set to its own tracer.
					dropSpanNames: ["McpServer/Notifications."],
					anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
				}),
				// Read by the bridge's `HttpMiddleware.tracer`; cannot live in the app graph.
				AlchemyTelemetry.layer(AiObservabilityLive),
			),
		),
	),
)
