import { execFileSync } from "node:child_process"
import path from "node:path"
import alchemy from "alchemy"
import { Ai, DurableObjectNamespace, Worker, WorkerLoader } from "alchemy/cloudflare"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveDeploymentEnvironment,
	resolveWorkerName,
} from "@maple/infra/cloudflare"

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

export interface CreateChatFlueWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	mapleApiUrl: string
}

/**
 * Deploy the Flue chat worker (`apps/chat-flue`) via alchemy, consistent with
 * the rest of the stack.
 *
 * Flue builds its own Cloudflare entrypoint + Durable Object classes, so this
 * runs `flue build` first, then deploys the prebuilt bundle with `noBundle`
 * (alchemy uploads `index.js` + the code-split `assets/*.js` modules as-is).
 * Alchemy owns the bindings here — the generated `dist/.../wrangler.json` vars
 * and `.dev.vars` are NOT read (only `.js`/`.mjs` are uploaded), so no local
 * secret leaks into the deploy. Keep the DO binding NAMES and class names in
 * sync with the generated `dist/maple_chat_flue/wrangler.json`.
 *
 * Manual fallback (Flue-native): `cd apps/chat-flue && bun run build &&
 * wrangler deploy --config dist/maple_chat_flue/wrangler.json`.
 */
export const createChatFlueWorker = async ({ stage, domains, mapleApiUrl }: CreateChatFlueWorkerOptions) => {
	// Flue generates the Worker entrypoint + DO classes; build before deploy.
	execFileSync("bun", ["run", "build"], { cwd: import.meta.dirname, stdio: "inherit" })

	const distDir = path.join(import.meta.dirname, "dist", "maple_chat_flue")

	// Flue-generated Durable Objects. Names must match `env.FLUE_*` and the
	// class names exported by the built `index.js`; alchemy derives the v1
	// `new_sqlite_classes` migration from these sqlite namespaces.
	const chatAgent = DurableObjectNamespace("flue-maple-chat-agent", {
		className: "FlueMapleChatAgent",
		sqlite: true,
	})
	const triageWorkflow = DurableObjectNamespace("flue-triage-workflow", {
		className: "FlueTriageWorkflow",
		sqlite: true,
	})
	const registry = DurableObjectNamespace("flue-registry", {
		className: "FlueRegistry",
		sqlite: true,
	})

	const worker = await Worker("chat-flue", {
		name: resolveWorkerName("chat-flue", stage),
		cwd: distDir,
		entrypoint: path.join(distDir, "index.js"),
		// Deploy Flue's prebuilt bundle as-is (index.js + assets/*.js modules).
		noBundle: true,
		format: "esm",
		rules: [{ globs: ["**/*.js", "**/*.mjs"] }],
		compatibilityDate: "2026-06-01",
		compatibilityFlags: ["nodejs_compat"],
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Workers Observability. `traces.enabled` is required for the `tracing.enterSpan`
		// custom spans in src/agents/maple-chat.ts to emit; the `"maple"` destination
		// forwards both logs and traces over Cloudflare's native pipeline → Maple ingest
		// (the same path the existing auto-spans use, unlike the @flue/opentelemetry
		// export which doesn't flush reliably from DO isolates). `"maple"` is the
		// account-level telemetry destination id.
		observability: {
			enabled: true,
			logs: { destinations: ["maple"] },
			traces: { enabled: true, destinations: ["maple"] },
		},
		url: true,
		adopt: true,
		domains: domains.chat ? [{ domainName: domains.chat, adopt: true }] : undefined,
		bindings: {
			AI: Ai(),
			FLUE_MAPLE_CHAT_AGENT: chatAgent,
			FLUE_TRIAGE_WORKFLOW: triageWorkflow,
			FLUE_REGISTRY: registry,
			MAPLE_API_URL: mapleApiUrl,
			INTERNAL_SERVICE_TOKEN: alchemy.secret(requireEnv("INTERNAL_SERVICE_TOKEN")),
			// OpenTelemetry → Maple ingest. Provide the internal-org ingest key so
			// chat-flue spans land beside `maple-api`; telemetry no-ops when unset.
			...optionalSecret("MAPLE_INGEST_KEY"),
			...optionalPlain("MAPLE_ENDPOINT"),
			...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
			...optionalPlain("MAPLE_CHAT_MODEL"),
			...optionalPlain("MAPLE_TRIAGE_MODEL"),
			// Code Mode sandbox (Cloudflare Dynamic Workers). The `worker_loader`
			// binding powers the `run_code` tool's isolate; its presence is what
			// activates Code Mode at runtime. Requires Worker Loader beta access on
			// the account.
			LOADER: WorkerLoader(),
			...optionalPlain("MAPLE_AUTH_MODE", "self_hosted"),
			...optionalSecret("MAPLE_ROOT_PASSWORD"),
			...optionalSecret("CLERK_SECRET_KEY"),
			...optionalPlain("CLERK_PUBLISHABLE_KEY"),
			...optionalSecret("CLERK_JWT_KEY"),
		},
	})

	return worker
}
