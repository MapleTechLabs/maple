import { createOpenTelemetryObserver } from "@flue/opentelemetry"
import { observe } from "@flue/runtime"
import { flue } from "@flue/runtime/routing"
import { env } from "cloudflare:workers"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { instanceIdFromAgentPath, verifyInternalServiceToken, verifyRequest } from "./lib/auth.ts"
import type { ChatFlueEnv } from "./lib/env.ts"
import { orgIdFromInstanceId } from "./lib/org.ts"
import { CHAT_FLUE_SERVICE_NAME, rootContextFromRequest, setupTelemetry } from "./lib/telemetry.ts"

// ---------------------------------------------------------------------------
// Telemetry bridge
// ---------------------------------------------------------------------------
// `observe` is isolate-local, and this module's top-level body runs in every
// isolate the Flue-generated entry loads — the worker AND the chat-agent /
// triage Durable Objects — so the OTel observer is registered wherever the
// model/tool/run events actually fire. When MAPLE_INGEST_KEY is set we ship Flue
// events as OpenTelemetry spans to Maple's ingest (the Flue OTel adapter →
// `maple-chat-flue` service, GenAI `chat` spans, `flue.tool`/`flue.operation`,
// etc.); otherwise we fall back to the original structured error logging so
// local dev still surfaces failures with zero export noise.
const cfEnv = env as unknown as ChatFlueEnv
const tracerProvider = setupTelemetry({
	ingestKey: cfEnv.MAPLE_INGEST_KEY,
	endpoint: cfEnv.MAPLE_ENDPOINT,
	environment: cfEnv.MAPLE_ENVIRONMENT,
})

if (tracerProvider) {
	// Flue events → OpenTelemetry spans. Content (prompts, model I/O, tool
	// args/results, detailed errors) is omitted by default — intentional for an
	// AI chat; a redacted `exportContent` hook is a future opt-in.
	observe(
		createOpenTelemetryObserver({
			tracer: tracerProvider.getTracer(CHAT_FLUE_SERVICE_NAME),
			// Nest chat spans under the caller's (web/mobile) distributed trace
			// when it propagates `traceparent`; standalone otherwise.
			resolveRootContext: (_event, ctx) => rootContextFromRequest(ctx.req),
		}),
	)

	// workerd flush. `BatchSpanProcessor`'s timer is unreliable across isolate
	// suspension, and Durable-Object isolates have no `ctx.waitUntil`, so force a
	// flush at Flue's own terminal boundaries. (Worker-isolate HTTP spans are
	// drained from the Hono response middleware below.)
	observe((event) => {
		if (event.type === "run_end" || event.type === "idle" || event.type === "agent_end") {
			void tracerProvider.forceFlush()
		}
	})
} else {
	observe((event) => {
		if (event.type === "log" && event.level === "error") {
			console.error("[chat-flue]", event.message, event.attributes ?? {})
			return
		}
		if ("isError" in event && event.isError) {
			const label = "toolName" in event ? `tool ${event.toolName}` : event.type
			const detail = "error" in event ? event.error : undefined
			console.error(`[chat-flue] ${label} failed`, detail ?? "")
		}
	})
}

// ---------------------------------------------------------------------------
// HTTP application
// ---------------------------------------------------------------------------
const app = new Hono<{ Bindings: ChatFlueEnv }>()

// CORS. The web/mobile clients call this worker cross-origin (e.g.
// app.maple.dev → chat.maple.dev / *.workers.dev), so every response needs CORS
// headers. Registered FIRST so the OPTIONS preflight is answered here, before
// the `/agents/*` auth middleware — preflight requests carry no Authorization
// header and would otherwise be rejected with 401.
//
// Requests are non-credentialed (bearer token in a header, no cookies), so `*`
// origin is valid. `allowHeaders` is omitted on purpose: Hono then reflects the
// preflight's `Access-Control-Request-Headers`, covering `Authorization` plus
// whatever the Durable-Streams transport sends. The exposed `Stream-*` response
// headers are what `@flue/sdk`'s transport reads for offset/cursor bookkeeping —
// without exposing them the browser hides them and live tailing breaks.
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "OPTIONS"],
		exposeHeaders: [
			"Stream-Next-Offset",
			"Stream-Offset",
			"Stream-Cursor",
			"Stream-Seq",
			"Stream-Ttl",
			"Stream-Expires-At",
			"Stream-Closed",
			"Stream-Up-To-Date",
			"Stream-Api",
			"Stream-Forked-From",
			"Stream-Fork-Offset",
			"Stream-Response-State",
			"Stream-Response-Methods",
			"Stream-Db",
			"Stream-Level",
			"Stream-Sse-Data-Encoding",
		],
		maxAge: 86400,
	}),
)

// Drain worker-isolate spans before the isolate parks. `executionCtx` is absent
// under unit tests (`app.fetch(req, env)` with no third arg) — guard it; those
// spans flush at Flue's run/idle boundaries instead.
if (tracerProvider) {
	app.use("*", async (c, next) => {
		await next()
		try {
			c.executionCtx.waitUntil(tracerProvider.forceFlush())
		} catch {
			// No ExecutionContext available (tests) — nothing to schedule.
		}
	})
}

app.get("/health", (c) => c.json({ ok: true }))

// AuthN + per-instance authZ for direct agent access. The web client passes a
// Clerk/self-hosted session token (Authorization header, or `?token=` for the
// GET event stream, which can't set headers). The org it resolves to must own
// the addressed `"<orgId>:<tabId>"` instance — so a caller can never reach
// another org's conversation.
app.use("/agents/*", async (c, next) => {
	const verified = await verifyRequest(c.req.raw, c.env)
	if (!verified) return c.json({ error: "Authentication required" }, 401)

	// Deny-by-default: every /agents/* request must carry a resolvable
	// "<orgId>:<tabId>" instance whose org matches the caller. The agent
	// transports are `/agents/<name>/<id>`; a path without an instance id is
	// rejected rather than allowed through on AuthN alone.
	const instanceId = instanceIdFromAgentPath(new URL(c.req.url).pathname)
	if (!instanceId) return c.json({ error: "Missing agent instance id" }, 400)
	const namedOrgId = orgIdFromInstanceId(instanceId)
	if (!namedOrgId || namedOrgId !== verified.orgId) {
		return c.json({ error: "Organization does not match the addressed agent" }, 403)
	}

	await next()
})

// Internal-service guard for headless workflow invocations (apps/api → chat-flue,
// e.g. the triage workflow over the CHAT_FLUE service binding). Unlike /agents/*
// (which carry a user session token), /workflows/* is server-to-server, so it
// requires the internal-service token. Without this guard the route — which can
// run an org-scoped investigation for any org in the payload — is unauthenticated.
app.use("/workflows/*", async (c, next) => {
	if (!verifyInternalServiceToken(c.req.raw, c.env)) {
		return c.json({ error: "Authentication required" }, 401)
	}
	await next()
})

// Everything else (agent prompt/stream routes, workflow invocations, run reads,
// OpenAPI) is served by Flue's generated application.
app.route("/", flue())

export default app
