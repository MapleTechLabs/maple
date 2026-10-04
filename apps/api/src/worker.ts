/**
 * The api Worker (alchemy single-module form): both the resource the root stack
 * yields and the init the deployed isolate runs. Hosted classes (the Workflow)
 * are exported from the generated entry because the init yields them.
 */
import {
	AiWorker,
	chatSessionBinding,
	mapleDbEnv,
	type MapleDeployment,
	MapleStack,
	mapleWorkerProps,
} from "@maple/infra/cloudflare"
import { WORKER_PURE_OPTIONS } from "@maple/infra/worker-build"
import { isolateContext } from "@maple/infra/worker-http"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import { Effect, Layer } from "effect"
import { ApiObservabilityLive } from "./http/api-observability"
import { apiConfiguredEnv } from "./resources/env"
import { ApiBindingLayers, apiPorts, bindApiClients } from "./worker/bindings"
import { registerQueueConsumers } from "./worker/consumers"
import { registerCrons } from "./worker/crons"
import { makeAppGraphs, makeFetch } from "./worker/http"
import ClickHouseSchemaApplyWorkflow from "./workflows/ClickHouseSchemaApplyWorkflow"

/** Bindings alchemy's init clients cannot express; the rest come from `bindApiClients`. */
const makeWorkerBindings = (deployment: MapleDeployment) => ({
	// maple-ai's chat DO, bound under its class name (`chatSessionStub` reads it).
	ChatSession: chatSessionBinding(deployment),
})

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const { stage, region, domains, devEnv, db } = stack
	// api keeps the hostname and OAuth, and forwards `/mcp` and chat to maple-ai.
	const ai = yield* AiWorker
	// Resolved up front so a misconfigured deploy fails before applying anything.
	const configuredEnv = yield* apiConfiguredEnv(stage, region, domains)
	return {
		main: import.meta.url,
		...mapleWorkerProps("api", stack),
		workersDev: true,
		// Eager module evaluation keeps the DB graph's init off the first Postgres
		// dial of a cold isolate (docs/infra-history.md, "The cold-start regression").
		build: { output: { strictExecutionOrder: false }, pure: WORKER_PURE_OPTIONS },
		// Custom domain, not a zone route: routes create no DNS, so pr hosts would NXDOMAIN.
		domain: domains.api,
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
			...makeWorkerBindings({ stage, region }),
			...mapleDbEnv(db, "api"),
			AI_WORKER: ai,
			...configuredEnv,
			...devEnv,
		},
	}
})

export default class MapleApi extends Cloudflare.Worker<MapleApi>()(
	"api",
	props,
	Effect.gen(function* () {
		// Yielding a hosted class binds, registers and exports it; do not move it to another Worker.
		const schemaApply = yield* ClickHouseSchemaApplyWorkflow
		const clients = yield* bindApiClients
		const ports = apiPorts(clients, schemaApply, yield* Cloudflare.WorkerEnvironment)
		// Graphs build on the first event, not here: init also runs at plan time, where
		// alchemy would auto-bind every `Config` read. Lazy build keeps `/health` answering.
		const isolate = isolateContext(yield* Effect.context())
		const { app, queryApp } = yield* makeAppGraphs(isolate, ports)
		yield* registerCrons(ports)
		yield* registerQueueConsumers(ports)
		return { fetch: makeFetch(app, ports, queryApp) }
	}).pipe(
		// The init is the entry point: cron and queue sources need the host Worker.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				ApiBindingLayers,
				Cloudflare.Workers.CronEventSourceLive,
				Cloudflare.Queues.EventSourceLive,
				WorkerTelemetry({ serviceName: "maple-api" }),
				// Read by the bridge's `HttpMiddleware.tracer`; cannot live in the app graph.
				AlchemyTelemetry.layer(ApiObservabilityLive),
			),
		),
	),
) {}
