/**
 * The api Worker in alchemy's single-module form: this file is the resource
 * the root stack yields (`yield* MapleApi`) and the init the deployed isolate
 * runs. Stage-derived props read `MapleStack`; `impl` runs once per isolate,
 * on the first event, and registers the crons, the queue consumers, the
 * request handler and the internal RPC methods. The bridge builds the
 * telemetry into every event's scope and flushes it after — the request path
 * as `maple-api`, background work under its own service names (see
 * `eventTelemetry`).
 *
 * The bundle entry is `./entry.ts`, not this module (`isExternal` below): the
 * chat Durable Object and the two Workflows are still hand-written classes,
 * which alchemy's generated entry cannot carry. `entry.ts` builds the same
 * bridge that entry would around this init and exports those classes beside
 * it. Once they move to alchemy's forms, delete it and set
 * `main: import.meta.url` here.
 */
import type { MapleApiRpcContract } from "@maple/domain/internal-rpc"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	formatMapleStage,
	ManagedMapleDb,
	type MapleDomains,
	MapleStack,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	derived,
	ingestKeyCryptoEnv,
	merge,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	plainWithDefault,
	requireSecretEntry,
	selfObservabilityEnv,
	tinybirdEnv,
} from "@maple/infra/env"
import {
	WorkerConfigProviderLayer,
	WorkerEnvironment,
	workerEnvironmentLayer,
} from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { renamedFrom } from "alchemy/Rename"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import {
	Cause,
	Clock,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Path,
	Predicate,
	Scope,
	Stream,
} from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { HttpEffect } from "alchemy/Http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { createReplayBlobStore } from "../alchemy.run.ts"
import { API_CORS_RESPONSE_HEADERS, apiCorsPreflightResponse } from "./http/api-cors"
import { ApiObservabilityLive } from "./http/api-observability"
import { v2WorkerUnavailableResponse } from "./http/v2-worker-unavailable"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "./mcp/expected-failures"
import { persistSession, preloadSession, type SessionsBinding } from "./mcp/lib/session-store"

/**
 * Everything in the api worker's env that comes from configuration rather than
 * from a resource. Resolved as one `Config` so a deploy missing several vars
 * reports all of them at once, and so `.env` / `--env-file` reach it — see
 * `@maple/infra/env`.
 */
const apiConfiguredEnv = (stage: MapleStage, domains: MapleDomains) =>
	merge(
		tinybirdEnv,
		// ClickHouse (BYO warehouse); `tinybird` unless an org config overrides it.
		optionalPlain("CLICKHOUSE_URL"),
		plainWithDefault("CLICKHOUSE_PROVIDER", "tinybird"),
		optionalPlain("CLICKHOUSE_USER"),
		optionalPlain("CLICKHOUSE_DATABASE"),
		optionalSecret("CLICKHOUSE_PASSWORD"),
		// Dev-only; the runtime ignores it outside MAPLE_ENVIRONMENT=development.
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
		// Dev stages only: alchemy binds only what is declared here, and on a
		// deploy a pin would point the whole API at one tenant.
		...(stage.kind === "dev" ? [optionalPlain("MAPLE_ORG_ID_OVERRIDE")] : []),
		authEnv,
		ingestKeyCryptoEnv,
		requireSecretEntry("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		appUrlsEnv,
		// The worker's own canonical origin — everything it publishes about itself
		// (MCP `server.json`, the discovery index) is built from this rather than
		// from client-controlled forwarded headers. Stages with a real domain
		// derive it; the rest fall back to production, overridable per deploy.
		domains.api
			? derived("MAPLE_API_BASE_URL", `https://${domains.api}`)
			: plainWithDefault("MAPLE_API_BASE_URL", "https://api.maple.dev"),
		// Bucket-cache knobs: on by default in deployed stages. Override via
		// deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
		plainWithDefault("QE_BUCKET_CACHE_ENABLED", "true"),
		plainWithDefault("QE_BUCKET_CACHE_TTL_SECONDS", "86400"),
		plainWithDefault("QE_BUCKET_CACHE_FLUX_SECONDS", "60"),
		plainWithDefault("QE_BUCKET_CACHE_SEGMENT_BUCKETS", "120"),
		// Both of the next two knobs are bounded by Cloudflare's
		// six-simultaneous-connection limit, which `cache.match()` counts against
		// while it waits for response headers. Keep the deploy-time values in step
		// with the reasoning in `bucket-cache.ts` and `edge-cache.ts` — a stale
		// override here silently defeats a tuned default, which is exactly what
		// happened when these were pinned to 16/250 and the code defaults moved to
		// 6/40 underneath them.
		plainWithDefault("QE_BUCKET_CACHE_READ_CONCURRENCY", "6"),
		plainWithDefault("EDGE_CACHE_READ_TIMEOUT_MS", "40"),
		// MAPLE_ENDPOINT / MAPLE_ENVIRONMENT / COMMIT_SHA / MAPLE_INGEST_KEY.
		selfObservabilityEnv(stage),
		// Agent LLM path. `MAPLE_LLM_PROVIDER` flips between OpenRouter (default) and
		// Workers AI; both stay wired, so a switch is this one var plus a redeploy.
		// See `@/platform/Llm` for the provider-scoped model overrides.
		optionalPlain("MAPLE_LLM_PROVIDER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
		optionalSecret("OPENROUTER_API_KEY"),
		// Svix signing secrets for the public webhook receivers (`/webhooks/clerk`,
		// `/webhooks/autumn`); each route answers 503 until its secret is set.
		optionalSecret("CLERK_WEBHOOK_SECRET"),
		optionalSecret("AUTUMN_WEBHOOK_SECRET"),
		// Server-side product events default to MAPLE_INGEST_KEY; set this only if
		// the funnel should land in a different org than the API's traces.
		optionalSecret("MAPLE_PRODUCT_EVENTS_INGEST_KEY"),
		optionalSecret("AUTUMN_SECRET_KEY"),
		// Billing details (company name, address, tax IDs) are written to the Stripe
		// customer Autumn links; Autumn itself has no API for them.
		optionalSecret("STRIPE_SECRET_KEY"),
		optionalSecret("SD_INTERNAL_TOKEN"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		optionalPlain("HAZEL_API_BASE_URL"),
		optionalPlain("HAZEL_OAUTH_DISCOVERY_URL"),
		optionalPlain("HAZEL_OAUTH_CLIENT_ID"),
		optionalSecret("HAZEL_OAUTH_CLIENT_SECRET"),
		optionalPlain("HAZEL_OAUTH_SCOPES"),
		// Slack integration (bot install via OAuth v2)
		optionalPlain("SLACK_CLIENT_ID"),
		optionalSecret("SLACK_CLIENT_SECRET"),
		optionalSecret("SLACK_INTERNAL_SERVICE_TOKEN"),
		apnsEnv,
		optionalPlain("GITHUB_APP_ID"),
		optionalPlain("GITHUB_APP_SLUG"),
		optionalSecret("GITHUB_APP_PRIVATE_KEY"),
		optionalPlain("GITHUB_APP_CLIENT_ID"),
		optionalSecret("GITHUB_APP_CLIENT_SECRET"),
		optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
		optionalPlain("GITHUB_API_BASE_URL"),
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
	)

/**
 * The api worker's resource bindings, split from the `Config`-sourced env so
 * they read as the binding contract they are. The queue consumers are not
 * here: `consumeQueueMessages` in the init attaches each one to the Worker.
 */
const makeWorkerBindings = ({
	stage,
	mapleDb,
	replayBlobs,
	mcpSessions,
	vcsSyncQueue,
	planetScaleWebhookQueue,
	auditEventsQueue,
	auditEventsDlqName,
}: {
	stage: MapleStage
	mapleDb: Cloudflare.Hyperdrive.Connection | undefined
	replayBlobs: Cloudflare.R2.Bucket
	mcpSessions: Cloudflare.KV.Namespace
	vcsSyncQueue: Cloudflare.Queues.Queue
	planetScaleWebhookQueue: Cloudflare.Queues.Queue
	auditEventsQueue: Cloudflare.Queues.Queue
	auditEventsDlqName: string
}) => ({
	// Ref stages attach MAPLE_DB via `bindMapleDbRef` in the root stack.
	...(mapleDb ? { MAPLE_DB: mapleDb } : undefined),
	// Workers AI (`env.AI`, the v1 `Ai()` binding), driving the AI-triage agent on
	// `@opencode-ai/ai`. v2 emits the `{ type: "ai" }` binding by attaching an AI Gateway
	// resource, which also fronts model calls with caching/rate-limits/logging.
	// NOTE: the deploy token needs the account-level "AI Gateway: Edit" permission
	// for this resource.
	AI: Cloudflare.AI.Gateway("maple-api-ai"),
	// Durable chat transcripts, one Durable Object per "<orgId>:<tabId>". v2
	// provisions new DO classes as SQLite-backed by default. Class is exported
	// from src/entry.ts.
	CHAT_SESSION: Cloudflare.DurableObject("chat-session", { className: "ChatSession" }),
	MCP_SESSIONS: mcpSessions,
	// Read side of the replay payload store; absent bindings degrade to
	// inline-only hydration (see platform/ReplayBlobStore.ts).
	REPLAY_BLOBS: replayBlobs,
	VCS_SYNC_QUEUE: vcsSyncQueue,
	PLANETSCALE_WEBHOOK_QUEUE: planetScaleWebhookQueue,
	AUDIT_EVENTS_QUEUE: auditEventsQueue,
	// Read back by the init at plan time, for the audit consumer's dead-letter
	// setting — the init has the bound queues in hand there, not the stage.
	AUDIT_EVENTS_DLQ_NAME: auditEventsDlqName,
	// Long-running schema-apply: chunks heavy backfill migrations across durable
	// steps so they never hit the Worker request budget. Class is exported from
	// src/entry.ts. The first Workflow arg IS the physical workflow name; the
	// api worker hosts it (no scriptName), so alchemy registers it after deploy.
	CLICKHOUSE_SCHEMA_APPLY_WORKFLOW: Cloudflare.Workflow<{ orgId: string }>(
		resolveWorkerName("schema-apply", stage),
		{ className: "ClickHouseSchemaApplyWorkflow" },
	),
	// Fan-out investigation: N lens agents in parallel, then a validator that
	// promotes one cause and records why each rival lost. Class is exported from
	// src/entry.ts.
	INVESTIGATION_FANOUT_WORKFLOW: Cloudflare.Workflow<{
		orgId: string
		investigationId: string
		maxWidth: number
		reservedPasses: number
		attempt: number
	}>(resolveWorkerName("investigation-fanout", stage), {
		className: "InvestigationFanoutWorkflow",
	}),
	API_V2_RATE_LIMITER: Cloudflare.RateLimit("API_V2_RATE_LIMITER", {
		namespaceId: 2026071801,
		simple: { limit: 600, period: 60 },
	}),
	CLI_AUTH_RATE_LIMITER: Cloudflare.RateLimit("CLI_AUTH_RATE_LIMITER", {
		namespaceId: 2026072101,
		simple: { limit: 30, period: 60 },
	}),
	MCP_OAUTH_RATE_LIMITER: Cloudflare.RateLimit("MCP_OAUTH_RATE_LIMITER", {
		namespaceId: 2026072102,
		simple: { limit: 60, period: 60 },
	}),
	// Authenticated POST /mcp, per credential. A short window so a runaway
	// agent loop is cut off in seconds, at twice the v2 API's throughput.
	MCP_TOOLS_RATE_LIMITER: Cloudflare.RateLimit("MCP_TOOLS_RATE_LIMITER", {
		namespaceId: 2026082901,
		simple: { limit: 120, period: 10 },
	}),
	API_V2_RATE_LIMIT_PARTITION: formatMapleStage(stage),
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

/** The bundle alchemy deploys — see the module comment. */
const ENTRY = new URL("./entry.ts", import.meta.url).href

const stageQueue = (id: string, stage: MapleStage) =>
	Cloudflare.Queues.Queue(id, { name: resolveWorkerName(id, stage) })

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: ENTRY, isExternal: true }
	const { stage, domains, workerDev, devEnv } = yield* MapleStack
	// MAPLE_DB Hyperdrive comes in two flavors (see `ManagedMapleDb`): dev stages
	// get the alchemy-managed one yielded here; stg/prd bind a dashboard-managed
	// config by id after the Worker exists (`bindMapleDbRef` in the root stack);
	// PR previews get no database binding at all — the worker still boots and
	// serves, DB-backed routes 500 while everything else works.
	const mapleDb = yield* ManagedMapleDb
	// Declared once, by id: the root yields the same store for the ingest
	// gateway's write credentials, and this yield returns that registration.
	const { bucket: replayBlobs } = yield* createReplayBlobStore({ stage })
	// Resolved before any resource is created, so a misconfigured deploy fails
	// with the full list of missing vars rather than part-way through applying.
	const configuredEnv = yield* apiConfiguredEnv(stage, domains)
	const mcpSessions = yield* Cloudflare.KV.Namespace("MCP_SESSIONS", {
		title: resolveWorkerName("mcp-sessions", stage),
	})
	// Vendor-agnostic VCS sync queue (commit backfill + webhook deltas), the
	// PlanetScale webhook queue and the audit-events queue. This Worker is both
	// producer (bindings) and consumer (`consumeQueueMessages` in the init).
	// Under `alchemy dev` both halves are emulated in-process from this same
	// definition.
	const vcsSyncQueue = yield* stageQueue("vcs-sync", stage)
	const planetScaleWebhookQueue = yield* stageQueue("planetscale-webhooks", stage)
	const auditEventsQueue = yield* stageQueue("audit-events", stage)
	// Parking lot for audit entries that exhausted their retries. Deliberately
	// has no consumer: an entry landing here is a lost audit record, and the
	// point is that it survives for inspection instead of being dropped.
	const auditEventsDlq = yield* stageQueue("audit-events-dlq", stage)
	return {
		main: ENTRY,
		isExternal: true,
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
			...makeWorkerBindings({
				stage,
				mapleDb,
				replayBlobs,
				mcpSessions,
				vcsSyncQueue,
				planetScaleWebhookQueue,
				auditEventsQueue,
				auditEventsDlqName: resolveWorkerName("audit-events-dlq", stage),
			}),
			...configuredEnv,
			...devEnv,
		},
	}
})

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
	HttpPlatform.HttpPlatform,
	HttpPlatform.make({
		platform: "web",
		compression: HttpPlatform.makeCompressionWeb({
			algorithms: ["gzip", "deflate"],
			transform: (algorithm) => HttpPlatform.compressionTransformWeb(algorithm),
		}),
		fileResponse: (_path, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
		fileWebResponse: (_file, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
	}),
).pipe(Layer.provideMerge(WorkerFileSystemLive), Layer.provideMerge(Etag.layer))

const WorkerPlatformLive = Layer.mergeAll(
	Path.layer,
	Etag.layer,
	WorkerFileSystemLive,
	WorkerHttpPlatformLive,
)

/**
 * `Effect.cached`, except a failed build is forgotten: `cached` pins its exit,
 * failure included, for the isolate, and a build that failed on a transient
 * cause (a binding briefly unavailable) must be retried by a later event
 * rather than answer 503 until the isolate is replaced.
 */
const cachedRecoverable = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<Effect.Effect<A, E, R>> =>
	Effect.map(Effect.cachedInvalidateWithTTL(self, Duration.infinity), ([cached, invalidate]) =>
		cached.pipe(Effect.onError(() => invalidate)),
	)

/** A layer built for the isolate: its scope is never closed (workerd has no teardown), except when the build itself fails. */
const buildForIsolate = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make()
		return yield* Layer.buildWithScope(layer, scope).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
		)
	})

// The service graph, HTTP graph and database layer are imported DYNAMICALLY,
// not at module scope. The static import graph reachable from the HTTP graph
// eagerly builds hundreds of Effect Schema ASTs (`@maple/domain` + 47 MCP tool
// schemas) at module-evaluation time. Cloudflare runs only the top-level module
// scope during upload validation, so pulling that work in statically blew the
// fixed ~1s startup CPU budget (error 10021). Deferring it behind `import()`
// keeps the top level near-empty; the cost moves to the first event, which
// runs under the far larger per-request CPU budget. The Postgres scope module
// is deferred for the same reason.
const pgScopeModule = Effect.promise(() => import("./platform/pg-connection-scope"))
const rpcModule = Effect.promise(() => import("./internal-rpc"))
const vcsSyncModule = Effect.promise(() => import("./vcs-sync-runtime"))
const planetScaleWebhookModule = Effect.promise(() => import("./planetscale-webhook-runtime"))
const auditEventsModule = Effect.promise(() => import("./audit-events-runtime"))
const slackReconcileModule = Effect.promise(() => import("./slack-reconcile-runtime"))

/** The route graph as one request handler, built once per isolate on the first request. */
const buildApp = Effect.gen(function* () {
	const [{ HttpServicesLive }, { AllRoutes, ApiAuthLive }, { layerPg }] = yield* Effect.all([
		Effect.promise(() => import("./runtime/service-graph")),
		Effect.promise(() => import("./runtime/http-graph")),
		Effect.promise(() => import("./platform/DatabasePgLive")),
	])
	const scope = yield* Scope.make()
	const handler = yield* HttpRouter.toHttpEffect(
		AllRoutes.pipe(
			Layer.provideMerge(HttpServicesLive),
			Layer.provideMerge(ApiAuthLive),
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(workerEnvironmentLayer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	).pipe(
		Scope.provide(scope),
		Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
	)
	return bridgeHandler(handler)
})

/**
 * The router's handler as the bridge serves it.
 *
 * SAFETY: `toHttpEffect` keeps the routes' request-scoped markers in the
 * handler's type — the services they read per request, and the failures they
 * declare — but the context it builds runs them with every service the graph
 * merged (the same services `Layer.provideMerge` put there), and a failure
 * that escapes a route reaches alchemy's boundary, which renders a Respondable
 * as its own response and anything else as an empty 500. The retired entry
 * discharged the same markers by handing `toWebHandler` an empty request
 * context; this is that discharge, in one place.
 */
const bridgeHandler = <E, R>(
	handler: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | Scope.Scope | HttpServerRequest.HttpServerRequest
	>,
): HttpEffect => handler as HttpEffect

/**
 * RPC has no HttpApi request to construct the application services for it, so
 * it gets a sibling isolate-wide service graph — the headless one the MCP tools
 * run on.
 */
const buildRpcServices = Effect.gen(function* () {
	const [{ InvestigationServicesLive }, { layerPg }] = yield* Effect.all([
		Effect.promise(() => import("./runtime/mcp-service-graph")),
		Effect.promise(() => import("./platform/DatabasePgLive")),
	])
	return yield* buildForIsolate(
		InvestigationServicesLive.pipe(
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(workerEnvironmentLayer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	)
})

const pathOf = (url: string): string => {
	const query = url.indexOf("?")
	return query === -1 ? url : url.slice(0, query)
}

const isV2Path = (path: string): boolean => path === "/v2" || path.startsWith("/v2/")

const isSessionsBinding = (value: unknown): value is SessionsBinding =>
	Predicate.hasProperty(value, "get") &&
	typeof value.get === "function" &&
	Predicate.hasProperty(value, "put") &&
	typeof value.put === "function"

/** The route graph could not finish bootstrapping: the canonical v2 fallback, or a plain 504 for the rest. */
const unavailableResponse = (path: string) =>
	HttpServerResponse.fromWeb(
		isV2Path(path)
			? v2WorkerUnavailableResponse()
			: new Response("The API worker is temporarily unavailable.", { status: 504 }),
	)

/**
 * The request handler the bridge serves. Liveness and preflights answer before
 * the route graph exists: neither needs the domain graph, authentication, the
 * database scope or the route codecs, and a cold isolate can report health
 * when an unrelated binding is unavailable. Everything else runs the router
 * under one Postgres connection for the request.
 *
 * MCP session persistence is driven from here rather than from inside the
 * MCP layer: the sessions Map hands Effect's MCP server its transcript, and
 * the KV copy behind it is what lets the next isolate find a session this one
 * issued.
 */
export const makeFetch = (app: Effect.Effect<HttpEffect, unknown>) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const path = pathOf(request.url)
		if (request.method === "GET" && path === "/health") {
			return HttpServerResponse.text("OK", { headers: API_CORS_RESPONSE_HEADERS })
		}
		if (request.method === "OPTIONS") return HttpServerResponse.fromWeb(apiCorsPreflightResponse())

		const env = yield* Cloudflare.WorkerEnvironment
		const isMcp = request.method === "POST" && path === "/mcp"
		const sessions = isMcp && isSessionsBinding(env.MCP_SESSIONS) ? env.MCP_SESSIONS : undefined
		const requestSessionId = isMcp ? request.headers["mcp-session-id"] : undefined
		const startedAt = yield* Clock.currentTimeMillis

		// The cold handler build and the independent KV read overlap: warm
		// requests resolve both at once, cold MCP requests hide KV latency behind
		// module evaluation.
		const [built, { withPgConnectionScope }] = yield* Effect.all(
			[
				Effect.exit(app),
				pgScopeModule,
				sessions && requestSessionId
					? Effect.promise(() => preloadSession(sessions, requestSessionId))
					: Effect.void,
			],
			{ concurrency: "unbounded" },
		)
		if (Exit.isFailure(built)) {
			yield* Effect.logError("API worker route graph failed to build", built.cause).pipe(
				Effect.annotateLogs({ method: request.method, path }),
			)
			return unavailableResponse(path)
		}

		const response = yield* withPgConnectionScope(built.value).pipe(
			Effect.provideService(WorkerEnvironment, env),
		)

		if (sessions && isMcp) {
			// Only persist when the server issued a new session — i.e. on
			// `initialize`, where the response sid differs from the request sid
			// (or the request had none). Subsequent requests echo the same sid;
			// re-putting on every call would burn KV write quota for no reason.
			const responseSessionId = response.headers["mcp-session-id"]
			if (responseSessionId && responseSessionId !== requestSessionId) {
				const put = persistSession(sessions, responseSessionId)
				if (put) {
					const exec = yield* Cloudflare.WorkerExecutionContext
					yield* exec.waitUntil(Effect.promise(() => put))
				}
			}
		}
		if (isMcp) {
			const now = yield* Clock.currentTimeMillis
			yield* Effect.logInfo("MCP request handled").pipe(
				Effect.annotateLogs({
					"mcp.session_id": requestSessionId ?? "-",
					"mcp.response_session_id": response.headers["mcp-session-id"] ?? "-",
					"http.response.status_code": response.status,
					duration_ms: now - startedAt,
				}),
			)
		}
		return response
	})

/**
 * The bound queues, as the init needs them for `consumeQueueMessages`. At plan
 * time the props above already declared them, so they are read back off the
 * host rather than declared twice; in the isolate the declarations resolve
 * their attributes from the env the plan bound, and the props are inert.
 */
const boundQueues = (host: Cloudflare.Worker) =>
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) {
			// SAFETY: a declaration yielded in the isolate never touches a provider —
			// its attributes resolve from the env — so the provider requirement the
			// declaration's type carries is erased here, for the runtime only.
			const declare = (id: string) =>
				Cloudflare.Queues.Queue(id, {}) as Effect.Effect<Cloudflare.Queues.Queue>
			return {
				vcsSync: yield* declare("vcs-sync"),
				planetScaleWebhooks: yield* declare("planetscale-webhooks"),
				auditEvents: yield* declare("audit-events"),
				auditEventsDlqName: undefined,
			}
		}
		const env: unknown = host.Props.env
		const bound = (name: string) => {
			const value = Predicate.hasProperty(env, name) ? env[name] : undefined
			return Cloudflare.Queues.isQueue(value)
				? Effect.succeed(value)
				: Effect.die(new Error(`The api Worker's env does not bind the queue "${name}"`))
		}
		const dlqName = Predicate.hasProperty(env, "AUDIT_EVENTS_DLQ_NAME")
			? env.AUDIT_EVENTS_DLQ_NAME
			: undefined
		return {
			vcsSync: yield* bound("VCS_SYNC_QUEUE"),
			planetScaleWebhooks: yield* bound("PLANETSCALE_WEBHOOK_QUEUE"),
			auditEvents: yield* bound("AUDIT_EVENTS_QUEUE"),
			auditEventsDlqName: typeof dlqName === "string" ? dlqName : undefined,
		}
	})

/**
 * A fire's outcome: interrupts are isolate teardown (the schedule re-fires) and
 * a failure is logged rather than re-raised — alchemy's cron source reports
 * every fire as successful anyway. Under the fire's own SDK instance, flushed
 * when it returns.
 */
const settleFire =
	(cron: string, telemetry: Layer.Layer<never, never, Cloudflare.WorkerEnvironment>) =>
	<A, E, R>(fire: Effect.Effect<A, E, R>) =>
		fire.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Effect.logError("API cron fire failed", cause).pipe(
							Effect.annotateLogs({ "maple.api.cron": cron }),
						),
			),
			// A per-event layer, on purpose: its scope is the fire, and closing it
			// is what flushes the fire's telemetry.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(telemetry),
		)

// Dispatched by `Cloudflare.Workers.cron` below:
//   every 12h — VCS sync backstop, enqueues a refresh per installation
//   hourly    — scrape_target_checks retention (was inline on the
//               scrape-results write path; a busy target writes ~75k
//               rows/day, so the 10k cap binds within hours)
//   every 6h  — Slack workspace reconciliation: backstop for
//               SlackEventsRouter (app_uninstalled/tokens_revoked), which
//               catches deliveries Slack never sent/retried through, or
//               installs that predate the webhook
const VCS_SYNC_CRON = "0 */12 * * *"
const SCRAPE_RETENTION_CRON = "0 * * * *"
const SLACK_RECONCILE_CRON = "0 */6 * * *"

// Consumer settings, attached to the Worker by `consumeQueueMessages`. The
// audit consumer's `maxRetries` must stay in sync with AUDIT_EVENTS_MAX_RETRIES
// in audit-events-runtime.ts, which logs the drop on the final attempt; the
// VCS one with VCS_SYNC_MAX_RETRIES in vcs-sync-runtime.ts.
const VCS_SYNC_CONSUMER = {
	batchSize: 10,
	maxConcurrency: 2,
	maxRetries: 3,
	maxWaitTime: "5 seconds",
} satisfies Cloudflare.Queues.MessagesProps
const PLANETSCALE_WEBHOOKS_CONSUMER = VCS_SYNC_CONSUMER
// Audit entries tolerate a few seconds of delivery latency; batch wider and
// wait longer so one insert round-trip covers many entries.
const auditEventsConsumer = (deadLetterQueue: string | undefined): Cloudflare.Queues.MessagesProps => ({
	batchSize: 25,
	maxConcurrency: 2,
	maxRetries: 5,
	maxWaitTime: "5 seconds",
	deadLetterQueue,
})

export default class MapleApi extends Cloudflare.Worker<MapleApi>()(
	"api",
	props,
	Effect.gen(function* () {
		const host = yield* Cloudflare.Worker
		const queues = yield* boundQueues(host)
		// Built on the first event and kept for the isolate — not here, in init:
		// init also runs at plan time, where alchemy auto-binds every `Config` it
		// sees read onto the Worker, and this Worker's env is declared in full by
		// `props`.
		const app = yield* cachedRecoverable(buildApp)
		const rpcServices = yield* cachedRecoverable(buildRpcServices)
		const pgScope = yield* Effect.cached(pgScopeModule)
		const rpc = yield* Effect.cached(rpcModule)
		const vcsSync = yield* Effect.cached(vcsSyncModule)
		const planetScaleWebhooks = yield* Effect.cached(planetScaleWebhookModule)
		const auditEvents = yield* Effect.cached(auditEventsModule)
		const slackReconcile = yield* Effect.cached(slackReconcileModule)

		// One cron fire: the tick over its own light layer graph, one Postgres
		// socket for the tick.
		yield* Cloudflare.Workers.cron(VCS_SYNC_CRON, () =>
			Effect.gen(function* () {
				const [
					{ buildVcsScheduledLayer, runScheduledSync, vcsSyncTelemetry },
					{ withPgConnectionScope },
				] = yield* Effect.all([vcsSync, pgScope])
				return yield* withPgConnectionScope(runScheduledSync).pipe(
					Effect.provide(buildVcsScheduledLayer()),
					settleFire(VCS_SYNC_CRON, vcsSyncTelemetry),
				)
			}),
		)
		yield* Cloudflare.Workers.cron(SCRAPE_RETENTION_CRON, () =>
			Effect.gen(function* () {
				const [
					{ buildScrapeRetentionLayer, vcsSyncTelemetry },
					{ withPgConnectionScope },
					{ runScrapeCheckRetention },
					{ runPlanetScaleEventRetention },
				] = yield* Effect.all([
					vcsSync,
					pgScope,
					Effect.promise(() => import("./services/integrations/scrape-check-retention")),
					Effect.promise(() => import("./services/integrations/planetscale-event-retention")),
				])
				// Both sweeps ride this one cron: each new cron string costs a branch
				// here, and neither needs its own beat. Sequential, not concurrent —
				// they share one Postgres socket for the whole tick, so running them
				// concurrently would only queue on it.
				return yield* withPgConnectionScope(
					Effect.andThen(runScrapeCheckRetention, runPlanetScaleEventRetention),
				).pipe(
					Effect.provide(buildScrapeRetentionLayer()),
					settleFire(SCRAPE_RETENTION_CRON, vcsSyncTelemetry),
				)
			}),
		)
		yield* Cloudflare.Workers.cron(SLACK_RECONCILE_CRON, () =>
			Effect.gen(function* () {
				const [
					{ buildSlackReconcileLayer, runSlackReconciliation, slackReconcileTelemetry },
					{ withPgConnectionScope },
				] = yield* Effect.all([slackReconcile, pgScope])
				return yield* withPgConnectionScope(runSlackReconciliation).pipe(
					Effect.provide(buildSlackReconcileLayer()),
					settleFire(SLACK_RECONCILE_CRON, slackReconcileTelemetry),
				)
			}),
		)

		// The queue consumers. Each processes its batch per message (ack / retry
		// are the consumer's decisions; the event source's batch ack afterwards is
		// ignored for a message already retried) over its own light layer graph and
		// one Postgres socket for the batch. `renamedFrom` carries the consumer
		// resources over from the ids the api factory declared them under, so the
		// deploy migrates their state rows instead of re-creating the consumers.
		yield* Cloudflare.Queues.consumeQueueMessages(queues.vcsSync, VCS_SYNC_CONSUMER, (stream) =>
			Effect.gen(function* () {
				const [{ buildVcsSyncLayer, processBatch, vcsSyncTelemetry }, { withPgConnectionScope }] =
					yield* Effect.all([vcsSync, pgScope])
				const messages = yield* Stream.runCollect(stream)
				yield* withPgConnectionScope(processBatch({ messages })).pipe(
					Effect.provide(buildVcsSyncLayer()),
					Effect.provide(vcsSyncTelemetry),
				)
			}),
		).pipe(renamedFrom({ fqn: "vcs-sync-consumer" }))
		yield* Cloudflare.Queues.consumeQueueMessages(
			queues.planetScaleWebhooks,
			PLANETSCALE_WEBHOOKS_CONSUMER,
			(stream) =>
				Effect.gen(function* () {
					const [
						{
							buildPlanetScaleWebhookLayer,
							processPlanetScaleWebhookBatch,
							planetScaleWebhookTelemetry,
						},
						{ withPgConnectionScope },
					] = yield* Effect.all([planetScaleWebhooks, pgScope])
					const messages = yield* Stream.runCollect(stream)
					yield* withPgConnectionScope(processPlanetScaleWebhookBatch({ messages })).pipe(
						Effect.provide(buildPlanetScaleWebhookLayer()),
						Effect.provide(planetScaleWebhookTelemetry),
					)
				}),
		).pipe(renamedFrom({ fqn: "planetscale-webhooks-consumer" }))
		yield* Cloudflare.Queues.consumeQueueMessages(
			queues.auditEvents,
			auditEventsConsumer(queues.auditEventsDlqName),
			(stream) =>
				Effect.gen(function* () {
					const [{ buildAuditEventsLayer, processAuditEventsBatch }, { withPgConnectionScope }] =
						yield* Effect.all([auditEvents, pgScope])
					const messages = yield* Stream.runCollect(stream)
					yield* withPgConnectionScope(processAuditEventsBatch({ messages })).pipe(
						Effect.provide(buildAuditEventsLayer()),
					)
				}),
		).pipe(renamedFrom({ fqn: "audit-events-consumer" }))

		// The internal RPC surface, over a service binding. The bridge envelopes a
		// typed failure for the caller's `toRpcAsync` and throws a defect as-is;
		// one Postgres socket per call, released with it.
		const runRpc = <A, E, R>(program: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const [services, { withPgConnectionScope }] = yield* Effect.all([
					rpcServices.pipe(Effect.orDie),
					pgScope,
				])
				return yield* withPgConnectionScope(program).pipe(Effect.provide(services))
			})
		const internalRpc = {
			listMcpTools: () => Effect.flatMap(rpc, ({ listMcpToolsRpc }) => runRpc(listMcpToolsRpc)),
			callMcpTool: (input: unknown) =>
				Effect.flatMap(rpc, ({ callMcpToolRpc }) => runRpc(callMcpToolRpc(input))),
			submitDiagnosis: (input: unknown) =>
				Effect.flatMap(rpc, ({ submitDiagnosisRpc }) => runRpc(submitDiagnosisRpc(input))),
		} satisfies MapleApiRpcContract

		return { fetch: makeFetch(app), ...internalRpc }
	}).pipe(
		// The Worker's init IS the entry point: the cron and queue sources need
		// the host Worker, which only exists here, and the bridge builds the
		// telemetry — the SDK exporters plus the tracer filter and header
		// redaction the api's server spans need — into each event's scope.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				Cloudflare.Workers.CronEventSourceLive,
				Cloudflare.Queues.EventSourceLive,
				WorkerTelemetry({
					serviceName: "maple-api",
					dropSpanNames: ["McpServer/Notifications."],
					anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
				}),
				AlchemyTelemetry.layer(ApiObservabilityLive),
			),
		),
	),
) {}

/** The deployed api Worker, as the root stack and the web app's service binding see it. */
export type MapleApiWorker = Effect.Success<typeof MapleApi>
