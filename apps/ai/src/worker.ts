import { MapleStack, resolveWorkerName, CLOUDFLARE_WORKER_PLACEMENT } from "@maple/infra/cloudflare"
import { merge, optionalPlain, optionalSecret, selfObservabilityEnv } from "@maple/infra/env"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { makeAiService } from "./service"

const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, workerDev, devEnv } = yield* MapleStack
	const configured = yield* merge(
		selfObservabilityEnv(stage),
		optionalPlain("MAPLE_LLM_PROVIDER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
		optionalPlain("MAPLE_TRIAGE_MODEL_CONTEXT"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OUTPUT"),
		optionalPlain("MAPLE_LENS_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_LENS_MODEL_WORKERS_AI"),
		optionalPlain("MAPLE_TRIAGE_REASONING_EFFORT"),
		optionalPlain("MAPLE_LENS_REASONING_EFFORT"),
		optionalSecret("OPENROUTER_API_KEY"),
	)
	return {
		main: import.meta.url,
		name: resolveWorkerName("ai", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		dev: workerDev("ai"),
		workersDev: false,
		env: { AI: Cloudflare.AI.Gateway("maple-ai"), ...configured, ...devEnv },
	}
})

/** Private execution service: no application database, public routes, or durable state. */
export default class MapleAi extends Cloudflare.Worker<MapleAi>()(
	"ai",
	props,
	Effect.gen(function* () {
		const env = yield* Cloudflare.WorkerEnvironment
		return {
			...makeAiService(env),
			fetch: Effect.succeed(HttpServerResponse.empty({ status: 404 })),
		}
	}).pipe(
		// The Worker init is the application entry point.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(WorkerTelemetry({ serviceName: "maple-ai" })),
	),
) {}
