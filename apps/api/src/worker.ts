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
	CLOUDFLARE_WORKER_PLACEMENT,
	formatMapleStage,
	MapleStack,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import ChatSessionObject from "./chat/ChatSession"
import { ApiObservabilityLive } from "./http/api-observability"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "./mcp/expected-failures"
import { cachedRecoverable } from "./platform/cached-recoverable"
import { apiConfiguredEnv } from "./resources/env"
import { ApiBindingLayers, apiPorts, bindApiClients, RATE_LIMIT_PARTITION_ENV } from "./worker/bindings"
import { registerQueueConsumers } from "./worker/consumers"
import { registerCrons } from "./worker/crons"
import { buildApp, makeFetch } from "./worker/http"
import { buildRpcServices, makeInternalRpc } from "./worker/rpc"
import ClickHouseSchemaApplyWorkflow from "./workflows/ClickHouseSchemaApplyWorkflow"
import InvestigationFanoutWorkflow from "./workflows/InvestigationFanoutWorkflow"

/**
 * The bindings that stay declared on `env`. Everything the services reach at
 * runtime is bound by the init instead (`bindApiClients`); what is left here
 * is bound by stage — alchemy's capabilities have no "on some stages" form —
 * or read by name by code the Worker does not own (the LLM shim's `AI`).
 */
const makeWorkerBindings = ({ stage }: { stage: MapleStage }) => ({
	// Workers AI (`env.AI`, the v1 `Ai()` binding), driving the AI-triage agent on
	// `@opencode-ai/ai`. v2 emits the `{ type: "ai" }` binding by attaching an AI Gateway
	// resource, which also fronts model calls with caching/rate-limits/logging.
	// NOTE: the deploy token needs the account-level "AI Gateway: Edit" permission
	// for this resource.
	AI: Cloudflare.AI.Gateway("maple-api-ai"),
	// The stage partition every rate limiter scopes its keys under.
	[RATE_LIMIT_PARTITION_ENV]: formatMapleStage(stage),
	// Production only: preview/stg workers run the same email crons against
	// their own DB branches, so a binding here means every live stage sends
	// its own copy of onboarding/digest/alert emails to real users.
	...(stage.kind === "prd"
		? {
				EMAIL: Cloudflare.Email.SendEmail("email", {
					allowedSenderAddresses: ["notifications@noreply.maple.dev"],
				}),
			}
		: undefined),
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
			...configuredEnv,
			...devEnv,
		},
	}
})

export default class MapleApi extends Cloudflare.Worker<MapleApi>()(
	"api",
	props,
	Effect.gen(function* () {
		// The Durable Object and the Workflows this Worker hosts. Yielding each
		// binds it (`ChatSession`, `ClickHouseSchemaApplyWorkflow`,
		// `InvestigationFanoutWorkflow` — the binding IS the class name),
		// registers the namespace / physical workflow at plan time and exports
		// the class from the generated entry; the routes reach them off the
		// env under those names.
		yield* ChatSessionObject
		yield* ClickHouseSchemaApplyWorkflow
		yield* InvestigationFanoutWorkflow
		// The queues, the KV namespace, the replay bucket and the rate limiters,
		// as typed clients: yielding each binds it at plan time and resolves it
		// from the env in the isolate. The ports the service graph depends on
		// are built over them (`apiPorts`).
		const clients = yield* bindApiClients
		const ports = apiPorts(clients, yield* Cloudflare.WorkerEnvironment)
		// The service graphs are built on the first event and kept for the
		// isolate — not here, in init: init also runs at plan time, where alchemy
		// auto-binds every `Config` it sees read onto the Worker, and this
		// Worker's env is declared in full by `props`. They build under the
		// isolate's context, captured before any event exists — never under the
		// first event's fiber (see `buildIsolateHandler`).
		const isolate = yield* Effect.context()
		const app = yield* cachedRecoverable(buildApp(isolate, ports.layer))
		const rpcServices = yield* cachedRecoverable(buildRpcServices(isolate, ports.layer))
		yield* registerCrons(ports.layer)
		yield* registerQueueConsumers(ports.layer)
		return { fetch: makeFetch(app, ports), ...(yield* makeInternalRpc(rpcServices, ports.database)) }
	}).pipe(
		// The Worker's init IS the entry point: the cron and queue sources need
		// the host Worker, which only exists here, and the bridge builds the
		// telemetry — the SDK exporters plus the tracer filter and header
		// redaction the api's server spans need — into each event's scope.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				ApiBindingLayers,
				Cloudflare.Workers.CronEventSourceLive,
				Cloudflare.Queues.EventSourceLive,
				WorkerTelemetry({
					serviceName: "maple-api",
					dropSpanNames: ["McpServer/Notifications."],
					anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
					eventLayer: ApiObservabilityLive,
				}),
			),
		),
	),
) {}

/** The deployed api Worker, as the root stack and the web app's service binding see it. */
export type MapleApiWorker = Effect.Success<typeof MapleApi>
