/**
 * The api Worker in alchemy's single-module form: this file is the resource
 * the root stack yields (`yield* MapleApi`) and the init the deployed isolate
 * runs. Stage-derived props read `MapleStack`; `impl` runs once per isolate,
 * on the first event, and yields the pieces the Worker hosts and serves —
 * each in its own module under `./worker`. The bridge builds the telemetry
 * into every event's scope and flushes it after: the request path as
 * `maple-api`, background work under its own service names (`eventTelemetry`).
 *
 * The bundle entry is the one alchemy generates around this module: the
 * default export is the Worker, and the chat Durable Object and the two
 * Workflows are alchemy classes the init yields — their bindings, the
 * namespace, the physical workflows and the entry's class exports all derive
 * from those yields.
 */
import {
	cachedRecoverable,
	CLOUDFLARE_WORKER_PLACEMENT,
	emailBinding,
	MapleStack,
	AiWorker,
	SandboxWorker,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import {
	INVESTIGATION_FANOUT_BINDING,
	type InvestigationFanoutWorkflowPayload,
} from "@maple/domain/investigation-fanout"
import * as Cloudflare from "alchemy/Cloudflare"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import { Context, Effect, Layer, Option } from "effect"
import { ApiObservabilityLive } from "./http/api-observability"
import { apiConfiguredEnv } from "./resources/env"
import { ApiBindingLayers, apiPorts, bindApiClients } from "./worker/bindings"
import { registerQueueConsumers } from "./worker/consumers"
import { registerCrons } from "./worker/crons"
import { buildApp, makeFetch } from "./worker/http"
import ClickHouseSchemaApplyWorkflow from "./workflows/ClickHouseSchemaApplyWorkflow"

/**
 * The bindings that stay declared on `env`. Everything the services reach at
 * runtime is bound by the init instead (`bindApiClients`); what is left here
 * is bound by stage — alchemy's capabilities have no "on some stages" form —
 * or read by name by code the Worker does not own (the LLM shim's `AI`).
 */
const makeWorkerBindings = ({ stage }: { stage: MapleStage }) => ({
	// Workers AI (`env.AI`) behind an AI Gateway, driving the AI-triage agent.
	// NOTE: the deploy token needs the account-level "AI Gateway: Edit" permission
	// for this resource. Deployed stages only: the gateway has no local emulation,
	// so declaring it under `alchemy dev` diffs it against Cloudflare and demands
	// an `alchemy login`; without the binding the Llm shim is a no-op.
	...emailBinding(stage),
	// The two classes maple-ai now hosts, bound cross-script under their CLASS
	// names — which is what `chatSessionStub` and `INVESTIGATION_FANOUT_BINDING`
	// read off `env`. `resolveWorkerName` rather than the yielded Worker's output
	// on purpose: consuming the output would make api's deploy wait on ai's, and
	// these are reference-only bindings that need no such ordering.
	ChatSession: Cloudflare.DurableObject("ChatSession", {
		className: "ChatSession",
		scriptName: resolveWorkerName("ai", stage),
	}),
	[INVESTIGATION_FANOUT_BINDING]: Cloudflare.Workflow<InvestigationFanoutWorkflowPayload>(
		INVESTIGATION_FANOUT_BINDING,
		{
			className: INVESTIGATION_FANOUT_BINDING,
			scriptName: resolveWorkerName("ai", stage),
		},
	),
})

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, domains, workerDev, devEnv } = yield* MapleStack
	// The agents' repository sandbox, reached only over this binding. Absent on
	// the stages that do not deploy it, where `SandboxClient` reports the tools
	// as unavailable rather than failing.
	const sandbox = yield* Effect.serviceOption(SandboxWorker)
	// maple-ai, which serves `/mcp` and the chat surface. api keeps the hostname
	// and forwards, so the public address and the OAuth identity do not move.
	const ai = yield* AiWorker
	// Resolved before any resource is created, so a misconfigured deploy fails
	// with the full list of missing vars rather than part-way through applying.
	const configuredEnv = yield* apiConfiguredEnv(stage, domains)
	return {
		main: import.meta.url,
		name: resolveWorkerName("api", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Under `bun dev`: a sticky port the app's route follows.
		dev: workerDev("api"),
		workersDev: true,
		// alchemy ≥ beta.70 sets rolldown `strictExecutionOrder: true`, which wraps
		// ~every chunk in a lazy `__esmMin` initializer. The DB module graph (drizzle
		// pgTable schemas + Effect Schema ASTs) then evaluates on first use — inside
		// the first Postgres call of each fresh isolate — instead of at script
		// startup. That is what stepped the cold dial from ~2s to ~9-11s on
		// 2026-08-08 (deploy 2679ba80) and produced the CONNECT_TIMEOUT incident;
		// see the 2026-08-11 investigation. Eager evaluation moves that cost back to
		// script startup, off the request path. If chunking ever regresses into
		// upstream #749 (`ScriptStartupError: Cannot access '<minified>' before
		// initialization`), the deploy fails loudly at upload — remove this override
		// and instead warm the DB graph off the request path.
		build: { output: { strictExecutionOrder: false } },
		// Custom domain (not a zone route): routes don't create DNS records, so
		// pr-stage hostnames would be authoritative NXDOMAIN. Custom domains
		// provision DNS + edge certs automatically.
		domain: domains.api,
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
			...makeWorkerBindings({ stage }),
			...(Option.isSome(sandbox) ? { SANDBOX: sandbox.value } : undefined),
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
		// The Durable Object and the Workflows this Worker hosts: yielding each
		// binds it under the class name, registers it at plan time and exports
		// the class from the generated entry.
		yield* ClickHouseSchemaApplyWorkflow
		const clients = yield* bindApiClients
		const ports = apiPorts(clients, yield* Cloudflare.WorkerEnvironment)
		// The service graphs are built on the first event, not here: init also
		// runs at plan time, where alchemy auto-binds every `Config` it sees read
		// onto the Worker, and this Worker's env is declared in full by `props`.
		// `cachedRecoverable` rather than building eagerly is what lets `/health`
		// and preflights answer while the graph cannot build. The captured context
		// drops the init's deferred execution context (a handler must see the
		// event's own) and the init's memo map.
		const isolate = Context.omit(
			Cloudflare.WorkerExecutionContext,
			Layer.CurrentMemoMap,
		)(yield* Effect.context())
		const app = yield* cachedRecoverable(buildApp(isolate, ports))
		yield* registerCrons(ports)
		yield* registerQueueConsumers(ports)
		return { fetch: makeFetch(app, ports) }
	}).pipe(
		// The init IS the entry point: the cron and queue sources need the host
		// Worker, which exists only here.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				ApiBindingLayers,
				Cloudflare.Workers.CronEventSourceLive,
				Cloudflare.Queues.EventSourceLive,
				WorkerTelemetry({
					serviceName: "maple-api",
					dropSpanNames: ["McpServer/Notifications."],
				}),
				// The references the bridge's `HttpMiddleware.tracer` reads, built into
				// every event beside the SDK; they cannot live in the app graph.
				AlchemyTelemetry.layer(ApiObservabilityLive),
			),
		),
	),
) {}
