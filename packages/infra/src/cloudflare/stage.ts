export type MapleStage =
	| { kind: "prd" }
	| { kind: "stg" }
	| { kind: "pr"; prNumber: number }
	| { kind: "dev"; name: string }

const PR_STAGE_RE = /^pr-(\d+)$/
// Underscores allowed so alchemy's default `dev_${USER}` stage parses as a dev stage.
const DEV_STAGE_RE = /^[a-z0-9][a-z0-9_-]*$/

export interface MapleDomains {
	web?: string
	landing?: string
	api?: string
	ingest?: string
	/** Standalone ElectricSQL shape-proxy worker (`apps/electric-sync`). */
	sync?: string
	/**
	 * Self-hosted ElectricSQL sync service (`apps/electric`, ECS Fargate). Only
	 * the `sync` worker ever dials it; it is public because that worker runs at
	 * the Cloudflare edge, and `ELECTRIC_SECRET` is what actually guards it.
	 */
	electric?: string
	/** Auto-updating local-mode dashboard SPA (the `maple` binary points users here by default). */
	local?: string
}

export const CLOUDFLARE_WORKER_PLACEMENT = { region: "aws:us-east-1" } as const

const PRD_DOMAINS: MapleDomains = {
	web: "app.maple.dev",
	api: "api.maple.dev",
	ingest: "ingest.maple.dev",
	sync: "sync.maple.dev",
	electric: "electric.maple.dev",
	landing: "maple.dev",
	local: "local.maple.dev",
}

const STG_DOMAINS: MapleDomains = {
	web: "staging.maple.dev",
	api: "api-staging.maple.dev",
	ingest: "ingest-staging.maple.dev",
	sync: "sync-staging.maple.dev",
	electric: "electric-staging.maple.dev",
	landing: "staging-landing.maple.dev",
	local: "local-staging.maple.dev",
}

export function parseMapleStage(stage: string): MapleStage {
	const normalized = stage.trim().toLowerCase()

	if (normalized === "prd") {
		return { kind: "prd" }
	}

	if (normalized === "stg") {
		return { kind: "stg" }
	}

	const prMatch = normalized.match(PR_STAGE_RE)
	if (prMatch) {
		const prNumber = Number(prMatch[1])
		if (Number.isSafeInteger(prNumber) && prNumber > 0) {
			return { kind: "pr", prNumber }
		}
	}

	if (DEV_STAGE_RE.test(normalized)) {
		// Underscores are accepted (alchemy's default stage is `dev_${USER}`) but
		// normalized to hyphens: `name` flows into Cloudflare worker/Hyperdrive
		// names, which only allow [a-z0-9-].
		return { kind: "dev", name: normalized.replaceAll("_", "-") }
	}

	throw new Error(
		`Unsupported deployment stage "${stage}". Expected prd, stg, pr-<number>, or a dev stage name matching [a-z0-9][a-z0-9_-]*.`,
	)
}

export function formatMapleStage(stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return "prd"
		case "stg":
			return "stg"
		case "pr":
			return `pr-${stage.prNumber}`
		case "dev":
			return stage.name
	}
}

export function resolveDeploymentEnvironment(stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return "production"
		case "stg":
			return "staging"
		case "pr":
			return `pr-${stage.prNumber}`
		case "dev":
			return "development"
	}
}

export function resolveMapleDomains(stage: MapleStage): MapleDomains {
	switch (stage.kind) {
		case "prd":
			return PRD_DOMAINS
		case "stg":
			return STG_DOMAINS
		case "pr":
			// Give PR previews stable, secret-free URLs. The default workers.dev URL
			// embeds the Cloudflare account subdomain, which Infisical masks as a
			// secret — GitHub then refuses to set the environment URL. Custom domains
			// under the `maple.dev` zone have no secret in them. They also keep every
			// inter-app URL a plain string at deploy time, which alchemy v2 requires:
			// resource attributes like `worker.url` are lazy Outputs that cannot be
			// string-interpolated into another worker's env. local-ui has no pr
			// domain (nothing links to it from previews); landing gets one so
			// marketing-page changes are reviewable on a stable URL.
			return {
				web: `app-pr-${stage.prNumber}.maple.dev`,
				api: `api-pr-${stage.prNumber}.maple.dev`,
				sync: `sync-pr-${stage.prNumber}.maple.dev`,
				landing: `landing-pr-${stage.prNumber}.maple.dev`,
			}
		case "dev":
			return {}
	}
}

export type MapleDatabaseMode = "ref" | "managed" | "none"

/**
 * How a stage reaches the application database.
 *
 * - `"ref"` — bind a dashboard-managed Hyperdrive config by ID (stg/prd).
 * - `"managed"` — alchemy creates a Hyperdrive whose origin is pushed from
 *   `MAPLE_PG_URL` (dev stages, against the docker-compose Postgres).
 * - `"none"` — no `MAPLE_DB` binding at all. `DatabasePgLive` then fails every
 *   query with a `DatabaseError`, so DB-backed routes 500 while the rest of the
 *   stack serves normally.
 *
 * PR previews are deliberately `"none"` (owner decision, 2026-08): the
 * per-PR PlanetScale branches billed continuously for time used and consumed
 * the account's Hyperdrive config cap. To reverse, return `"managed"` for `pr`
 * and restore the PlanetScale/Electric steps in
 * `.github/workflows/deploy-pr-preview.yml` (the scripts are kept, dormant).
 */
export function resolveDatabaseMode(stage: MapleStage): MapleDatabaseMode {
	switch (stage.kind) {
		case "prd":
		case "stg":
			return "ref"
		case "pr":
			return "none"
		case "dev":
			return "managed"
	}
}

/** Which worker is binding `MAPLE_DB`. prd gives each its own Hyperdrive config — see docs/infra.md. */
export type MapleDbConsumer = "api" | "alerting"

/**
 * Dashboard-managed Hyperdrive configs, bound by ID; deploys never see the
 * database credentials. Stages returning undefined get an alchemy-managed
 * Hyperdrive from MAPLE_PG_URL or no database — `resolveDatabaseMode` decides.
 * Config IDs are not secrets.
 */
export function resolveHyperdriveRefId(stage: MapleStage, consumer: MapleDbConsumer): string | undefined {
	switch (stage.kind) {
		case "prd":
			// Both target the PlanetScale `main` branch; their `origin_connection_limit`s
			// SUM against its `max_connections`.
			return consumer === "alerting"
				? "f473167201af4d2cae494f9989f1d742" // `maple-alerting-prd`
				: "ad4c487838594b89810b23e5fb14e129" // `maple-prd`
		case "stg":
			// TEMPORARY: staging shares prod's `maple-prd` config (owner decision,
			// 2026-07-14) — stg workers therefore read/write the PRODUCTION
			// database and the stg alerting crons overlap prod's. Replace with a
			// dedicated `maple-stg` config (PlanetScale `stg` branch) ASAP.
			// Deliberately NOT split per consumer here: stg is already pointed at the
			// wrong database, and splitting it would add a second wrong pool.
			return "ad4c487838594b89810b23e5fb14e129"
		case "pr":
		case "dev":
			return undefined
	}
}

export function resolveWorkerName(base: string, stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return `maple-${base}`
		case "stg":
			return `maple-${base}-stg`
		case "pr":
			return `maple-${base}-pr-${stage.prNumber}`
		case "dev":
			return `maple-${base}-dev-${stage.name}`
	}
}
