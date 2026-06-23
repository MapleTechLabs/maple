import type { CloudflareAIBinding } from "@flue/runtime/cloudflare"

/** Bindings + vars available to the Flue chat worker. */
export interface ChatFlueEnv {
	/** Workers AI binding. Backs the `cloudflare/*` model provider (env.AI.run). */
	AI: CloudflareAIBinding
	/** Base URL of the Maple API worker that hosts the MCP server (`/mcp`). */
	MAPLE_API_URL: string
	/** Shared secret for Maple internal-service auth (`Bearer maple_svc_<token>`). */
	INTERNAL_SERVICE_TOKEN: string
	/** Optional Workers AI model override, e.g. `cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast`. */
	MAPLE_CHAT_MODEL?: string
	/** Optional Workers AI model override for the headless triage workflow (falls back to MAPLE_CHAT_MODEL). */
	MAPLE_TRIAGE_MODEL?: string
	/** Deployment environment label, surfaced on telemetry. */
	MAPLE_ENVIRONMENT?: string

	// --- Code Mode (Cloudflare Dynamic Workers / Worker Loader) ---
	/**
	 * Worker Loader binding (`worker_loader`) used to spin up a fresh sandbox
	 * isolate per `run_code` call. Its presence is what activates Code Mode: when
	 * bound, the agent gets a `run_code` tool + the generated `maple.*` API; when
	 * absent (e.g. local dev), the agent uses the direct tools. Requires
	 * Cloudflare Worker Loader beta access on the account.
	 */
	LOADER?: WorkerLoader

	// --- Telemetry (OpenTelemetry → Maple ingest) ---
	/**
	 * Maple ingest key (org-scoped; use the internal-org key, same as `apps/api`).
	 * When unset, OTel export is disabled and the worker logs failures to stderr.
	 */
	MAPLE_INGEST_KEY?: string
	/** OTLP traces endpoint base. Defaults to `https://ingest.maple.dev`. */
	MAPLE_ENDPOINT?: string

	// --- Auth (mirrors apps/chat-agent/src/lib/auth.ts) ---
	/** `"clerk"` to verify Clerk session tokens, otherwise self-hosted HS256. */
	MAPLE_AUTH_MODE?: string
	/** Clerk secret key (clerk mode). */
	CLERK_SECRET_KEY?: string
	/** Clerk publishable key (clerk mode). */
	CLERK_PUBLISHABLE_KEY?: string
	/** Clerk JWT verification key (clerk mode). */
	CLERK_JWT_KEY?: string
	/** Shared HMAC secret for self-hosted HS256 session tokens. */
	MAPLE_ROOT_PASSWORD?: string
}
