import path from "node:path"
import alchemy from "alchemy"
import { D1Database, KVNamespace, R2Bucket, Worker } from "alchemy/cloudflare"
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

	// Session-replay rrweb event blobs. 30-day lifecycle matches the
	// session_replays / session_replay_chunks Tinybird TTL (see datasources.ts).
	const replaysBucketName = resolveWorkerName("replays", stage)
	const replaysBucket = await R2Bucket("MAPLE_REPLAYS", {
		name: replaysBucketName,
		adopt: true,
		lifecycle: [
			{
				id: "expire-replays-30d",
				conditions: { prefix: "" },
				enabled: true,
				deleteObjectsTransition: { condition: { maxAge: 60 * 60 * 24 * 30, type: "Age" } },
			},
		],
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
		bindings: {
			MAPLE_DB: mapleDb,
			MCP_SESSIONS: mcpSessions,
			MAPLE_REPLAYS: replaysBucket,
			// S3-compatible R2 credentials for presigning session-replay chunk
			// GET URLs (aws4fetch). Supplied at deploy time; the same values are
			// set on the Rust ingest service so it can PUT blobs.
			R2_BUCKET: replaysBucketName,
			...optionalPlain("R2_ENDPOINT"),
			...optionalSecret("R2_ACCESS_KEY_ID"),
			...optionalSecret("R2_SECRET_ACCESS_KEY"),
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
		},
	})

	return { worker, db: mapleDb }
}
