import { observe } from "@flue/runtime"
import { flue } from "@flue/runtime/routing"
import { Hono } from "hono"
import { instanceIdFromAgentPath, verifyRequest } from "./lib/auth.ts"
import type { ChatFlueEnv } from "./lib/env.ts"
import { orgIdFromInstanceId } from "./lib/org.ts"

// ---------------------------------------------------------------------------
// Telemetry bridge
// ---------------------------------------------------------------------------
// `observe` is isolate-local. Phase 1d ships structured logging of agent/tool/run
// failures; a full OpenTelemetry/OTLP exporter into Maple's own pipeline
// (`maple.*` attributes, Title-Case status — see CLAUDE.md self-observability and
// the maple-telemetry-conventions skill) is a follow-up: workerd OTLP export is
// non-trivial and not needed for parity with the legacy agent, which emitted no
// OTel of its own.
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

// ---------------------------------------------------------------------------
// HTTP application
// ---------------------------------------------------------------------------
const app = new Hono<{ Bindings: ChatFlueEnv }>()

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

// Everything else (agent prompt/stream routes, run reads, OpenAPI) is served by
// Flue's generated application.
app.route("/", flue())

export default app
