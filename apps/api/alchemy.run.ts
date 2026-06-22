import path from "node:path"
import alchemy from "alchemy"
import { D1Database, KVNamespace, Queue, Worker, WorkerLoader, WorkerStub, Workflow } from "alchemy/cloudflare"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { resolveD1Name, resolveDeploymentEnvironment, resolveWorkerName } from "@maple/infra/cloudflare"

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		throw new Error(`Missing required deployment env: ${key}`)
	}
	return value
}

const optionalPlain = (key: string, fallback?: string): Record<string, string> => {
	const value = process.env[key]?.trim() || fallback
	return value ? { [key]: value } : {}
}

const optionalSecret = (key: string): Record<string, ReturnType<typeof alchemy.secret>> => {
	const value = process.env[key]?.trim()
	return value ? { [key]: alchemy.secret(value) } : {}
}

export interface CreateMapleApiOptions {
	stage: MapleStage
	domains: MapleDomains
}

export const createMapleApi = async ({ stage, domains }: CreateMapleApiOptions) => {
	const mapleDb = await D1Database("MAPLE_DB", {
		name: resolveD1Name(stage),
		adopt: true,
		migrationsDir: path.resolve(import.meta.dirname, "../../packages/db/drizzle"),
		migrationsTable: "drizzle_migrations",
	})

	const mcpSessions = await KVNamespace("MCP_SESSIONS", {
		title: resolveWorkerName("mcp-sessions", stage),
		adopt: true,
	})

	// Long-running schema-apply: chunks heavy backfill migrations across durable
	// steps so they never hit the Worker request budget. Class is exported from
	// src/worker.ts.
	const schemaApplyWorkflow = Workflow<{ orgId: string }>("clickhouse-schema-apply-workflow", {
		workflowName: resolveWorkerName("schema-apply", stage),
		className: "ClickHouseSchemaApplyWorkflow",
	})

	// Headless AI triage agent: investigates freshly opened incidents (error or
	// anomaly) with read-only tools and writes a structured summary back to the
	// run row. Class is exported from src/worker.ts.
	const aiTriageWorkflow = Workflow<{
		orgId: string
		incidentKind: string
		incidentId: string
		issueId?: string
		runId: string
	}>("ai-triage-workflow", {
		workflowName: resolveWorkerName("ai-triage", stage),
		className: "AiTriageWorkflow",
	})

	// Vendor-agnostic VCS sync queue (commit backfill + webhook deltas). The same
	// `api` worker is both producer (binding) and consumer (eventSources). Local
	// dev is wired separately in wrangler.jsonc so miniflare runs it in-process.
	const vcsSyncQueue = await Queue("vcs-sync", {
		name: resolveWorkerName("vcs-sync", stage),
		adopt: true,
	})

	// Service binding to the chat-flue worker that hosts the Flue `triage`
	// workflow (the AI triage agent's investigation step). chat-flue is created
	// AFTER api in the root alchemy.run.ts (it needs api's URL), so a plain
	// service-binding ref to its name fails the api upload with CF error 10143
	// ("references Worker ... which was not found"). Reserve the name with an
	// empty WorkerStub first; chat-flue's real deploy adopts it (adopt: true).
	// This breaks the api↔chat-flue cycle without a URL dependency.
	const chatFlue = await WorkerStub("chat-flue-stub", {
		name: resolveWorkerName("chat-flue", stage),
		url: false,
	})

	const worker = await Worker("api", {
		name: resolveWorkerName("api", stage),
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
		compatibility: "node",
		compatibilityDate: "2026-04-08",
		url: true,
		adopt: true,
		routes: domains.api ? [{ pattern: `${domains.api}/*`, adopt: true }] : undefined,
		// Periodic VCS sync backstop (every 12h) — enqueues a refresh per installation; see worker.ts `scheduled`.
		crons: ["0 */12 * * *"],
		eventSources: [
			{
				queue: vcsSyncQueue,
				settings: {
					batchSize: 10,
					maxConcurrency: 2,
					maxRetries: 3,
					maxWaitTimeMs: 5000,
				},
			},
		],
		bindings: {
			MAPLE_DB: mapleDb,
			MCP_SESSIONS: mcpSessions,
			VCS_SYNC_QUEUE: vcsSyncQueue,
			CLICKHOUSE_SCHEMA_APPLY_WORKFLOW: schemaApplyWorkflow,
			AI_TRIAGE_WORKFLOW: aiTriageWorkflow,
			CHAT_FLUE: chatFlue,
			TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
			TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
			...optionalPlain("CLICKHOUSE_URL"),
			...optionalPlain("CLICKHOUSE_USER"),
			...optionalPlain("CLICKHOUSE_DATABASE"),
			...optionalSecret("CLICKHOUSE_PASSWORD"),
			MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
			MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY")),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")),
			MAPLE_INGEST_PUBLIC_URL:
				process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
			MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
			RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL?.trim() || "Maple <notifications@maple.dev>",
			// Bucket-cache knobs: on by default in deployed stages. Override via
			// deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
			QE_BUCKET_CACHE_ENABLED: process.env.QE_BUCKET_CACHE_ENABLED?.trim() || "true",
			QE_BUCKET_CACHE_TTL_SECONDS: process.env.QE_BUCKET_CACHE_TTL_SECONDS?.trim() || "86400",
			QE_BUCKET_CACHE_FLUX_SECONDS: process.env.QE_BUCKET_CACHE_FLUX_SECONDS?.trim() || "60",
			...optionalPlain("MAPLE_ENDPOINT"),
			...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
			...optionalPlain("COMMIT_SHA"),
			MAPLE_INGEST_KEY: alchemy.secret(requireEnv("MAPLE_OTEL_INGEST_KEY")),
			...optionalSecret("MAPLE_ROOT_PASSWORD"),
			...optionalSecret("CLERK_SECRET_KEY"),
			...optionalPlain("CLERK_PUBLISHABLE_KEY"),
			...optionalSecret("CLERK_JWT_KEY"),
			...optionalSecret("AUTUMN_SECRET_KEY"),
			...optionalSecret("SD_INTERNAL_TOKEN"),
			...optionalSecret("INTERNAL_SERVICE_TOKEN"),
			...optionalSecret("RESEND_API_KEY"),
			...optionalPlain("HAZEL_API_BASE_URL"),
			...optionalPlain("HAZEL_OAUTH_DISCOVERY_URL"),
			...optionalPlain("HAZEL_OAUTH_CLIENT_ID"),
			...optionalSecret("HAZEL_OAUTH_CLIENT_SECRET"),
			...optionalPlain("HAZEL_OAUTH_SCOPES"),
			...optionalPlain("GITHUB_APP_ID"),
			...optionalSecret("GITHUB_APP_PRIVATE_KEY"),
			...optionalPlain("GITHUB_APP_CLIENT_ID"),
			...optionalSecret("GITHUB_APP_CLIENT_SECRET"),
			...optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
			...optionalPlain("GITHUB_API_BASE_URL"),
			// Code Mode (Cloudflare Dynamic Workers). The `run_code` MCP tool runs
			// model-written code in a sandbox isolate via this `worker_loader` binding.
			// Added only when MAPLE_CODE_MODE is set (the binding needs Worker Loader
			// beta access); the tool stays inert at runtime without it.
			...optionalPlain("MAPLE_CODE_MODE"),
			...(process.env.MAPLE_CODE_MODE?.trim() ? { LOADER: WorkerLoader() } : {}),
		},
	})

	return { worker, db: mapleDb }
}
