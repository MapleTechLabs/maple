import { DEFAULT_MAPLE_REGION, isMapleRegion, type MapleRegion, regionSuffix } from "../region.ts"

export type MapleStage = { kind: "prd" } | { kind: "pr"; prNumber: number } | { kind: "dev"; name: string }

/** What one `alchemy deploy` is: a stage of one geographic instance. */
export interface MapleDeployment {
	readonly stage: MapleStage
	readonly region: MapleRegion
}

/** The alchemy stage suffix that selects the EU instance; absent means `us`. */
const REGION_STAGE_SUFFIX_RE = /-(eu)$/

const PR_STAGE_RE = /^pr-(\d+)$/
/** Names of the removed staging stage, in the spellings someone would actually type. */
const REMOVED_STAGE_NAMES = new Set(["stg", "stage", "staging"])
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

/**
 * Where a Worker's requests are steered to run. A placement hint is best
 * effort — Cloudflare may run the script elsewhere when the pinned location is
 * unhealthy — so it is not, on its own, a residency guarantee; the storage
 * behind an instance (Tinybird, Postgres, R2 and the Durable Objects, see
 * {@link resolveStorageJurisdiction}) is what is hard-pinned. The contractual
 * execution guarantee, Regional Services, is an Enterprise add-on the account
 * does not carry. `us` pins to us-east-1 so the Workers sit beside the
 * production database and the Tinybird workspace; `eu` to eu-central-1 for the
 * same reason on the EU instance.
 */
export function resolveWorkerPlacement(region: MapleRegion = DEFAULT_MAPLE_REGION): {
	readonly region: "aws:us-east-1" | "aws:eu-central-1"
} {
	switch (region) {
		case "us":
			return { region: "aws:us-east-1" }
		case "eu":
			return { region: "aws:eu-central-1" }
	}
}

/**
 * The R2 / Durable Object jurisdiction for an instance's storage, or
 * `undefined` for the non-jurisdictional default. Unlike placement this IS a
 * hard guarantee on every Cloudflare plan: a jurisdictional bucket or object
 * is stored and served only from data centres in that jurisdiction.
 * Jurisdiction is fixed at creation — an existing bucket cannot move — which is
 * why the EU instance gets new resources rather than relocated ones.
 */
export function resolveStorageJurisdiction(region: MapleRegion): "eu" | undefined {
	return region === "eu" ? "eu" : undefined
}

/**
 * Whether an instance hosts the apps that are shared across regions and hold
 * no customer data: the marketing site and the local-mode dashboard SPA. One
 * `maple.dev` exists, so only the `us` instance deploys them; the EU instance
 * deploys the product Workers alone.
 */
export function regionHostsSharedApps(region: MapleRegion): boolean {
	return region === DEFAULT_MAPLE_REGION
}

const PRD_DOMAINS: MapleDomains = {
	web: "app.maple.dev",
	api: "api.maple.dev",
	ingest: "ingest.maple.dev",
	sync: "sync.maple.dev",
	electric: "electric.maple.dev",
	landing: "maple.dev",
	local: "local.maple.dev",
}

/**
 * The EU instance's production hostnames, all under `eu.maple.dev` so the
 * region is the hostname: no application code routes on it, and a request to
 * an EU hostname cannot reach a US resource because the EU Workers are bound
 * to none. No landing or local-ui — see {@link regionHostsSharedApps}.
 */
const PRD_DOMAINS_EU: MapleDomains = {
	web: "app.eu.maple.dev",
	api: "api.eu.maple.dev",
	ingest: "ingest.eu.maple.dev",
	sync: "sync.eu.maple.dev",
	electric: "electric.eu.maple.dev",
}

export function parseMapleStage(stage: string): MapleStage {
	const normalized = stage.trim().toLowerCase()

	if (normalized === "prd") {
		return { kind: "prd" }
	}

	// These are rejected rather than left to fall through to the dev-stage
	// pattern, which they all match. The staging stage was removed (2026-09) after
	// sitting disabled and unreachable with its Hyperdrive ref pointed at the
	// production database; a `--stage stg` that quietly built a dev stack named
	// `maple-*-dev-stg` is not the failure anyone typing it wants — and someone
	// typing it from memory is as likely to write `staging`.
	if (REMOVED_STAGE_NAMES.has(normalized)) {
		throw new Error(
			`The "${normalized}" stage was removed. Deploy prd, a pr-<number> preview, or a dev stage name.`,
		)
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
		`Unsupported deployment stage "${stage}". Expected prd, pr-<number>, or a dev stage name matching [a-z0-9][a-z0-9_-]*.`,
	)
}

/**
 * The alchemy stage string names both the stage and the instance: `prd`,
 * `prd-eu`, `pr-12`, `dev_makisuo`, `dev_makisuo-eu`. The region rides on the
 * stage rather than on an env var because alchemy keys its state store by
 * stage — `prd` and `prd-eu` are therefore two independent stacks that can
 * never plan against each other's resources, and nothing has to remember to
 * set a second variable in lockstep. A `-eu` suffix always means the region:
 * a dev stage cannot be named `*-eu` and mean the US.
 *
 * PR previews are US-only (`pr-12-eu` is rejected): a preview has no database
 * and reviews code, not residency, and a second preview fleet per PR is real
 * money for nothing.
 */
export function parseMapleDeployment(raw: string): MapleDeployment {
	const normalized = raw.trim().toLowerCase()
	const match = normalized.match(REGION_STAGE_SUFFIX_RE)
	const suffix = match?.[1]
	const region: MapleRegion = suffix !== undefined && isMapleRegion(suffix) ? suffix : DEFAULT_MAPLE_REGION
	const stage = parseMapleStage(match ? normalized.slice(0, -match[0].length) : normalized)
	if (stage.kind === "pr" && region !== DEFAULT_MAPLE_REGION) {
		throw new Error(
			`PR previews deploy to the ${DEFAULT_MAPLE_REGION} instance only; "${raw}" asks for "${region}".`,
		)
	}
	return { stage, region }
}

export function formatMapleDeployment({ stage, region }: MapleDeployment): string {
	return `${formatMapleStage(stage)}${regionSuffix(region)}`
}

export function formatMapleStage(stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return "prd"
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
		case "pr":
			return `pr-${stage.prNumber}`
		case "dev":
			return "development"
	}
}

export function resolveMapleDomains(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): MapleDomains {
	switch (stage.kind) {
		case "prd":
			return region === "eu" ? PRD_DOMAINS_EU : PRD_DOMAINS
		case "pr":
			if (region !== DEFAULT_MAPLE_REGION) {
				throw new Error(`PR previews have no ${region} hostnames; see parseMapleDeployment.`)
			}
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
 * - `"ref"` — bind a dashboard-managed Hyperdrive config by ID (prd).
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
			return "ref"
		case "pr":
			return "none"
		case "dev":
			return "managed"
	}
}

/**
 * Which stages get the agents' repository sandbox.
 *
 * prd only, which is now the only stage with an application database. A PR
 * preview has none ({@link resolveDatabaseMode} returns `"none"`), so no
 * repository can be resolved there and a container would be provisioned to do
 * nothing but cost money. Dev stages are excluded for a sharper reason:
 * `alchemy dev` resolves a container image by pulling it locally, so
 * provisioning one would put a multi-gigabyte pull and a running Docker daemon
 * between every developer and `bun dev`, whichever apps they asked for.
 */
export function stageDeploysSandbox(stage: MapleStage): boolean {
	return stage.kind === "prd"
}

/** Which worker is binding `MAPLE_DB`. prd gives each its own Hyperdrive config — see docs/infra.md. */
export type MapleDbConsumer = "api" | "ai" | "alerting"

/**
 * Dashboard-managed Hyperdrive configs, bound by ID; deploys never see the
 * database credentials. Stages returning undefined get an alchemy-managed
 * Hyperdrive from MAPLE_PG_URL or no database — `resolveDatabaseMode` decides.
 * Config IDs are not secrets.
 */
export function resolveHyperdriveRefId(
	stage: MapleStage,
	consumer: MapleDbConsumer,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string | undefined {
	switch (stage.kind) {
		case "prd":
			if (region === "eu") {
				// Deliberately a defect and not `undefined`: undefined means "no
				// database" (a PR preview), and an EU instance that silently deployed
				// with no `MAPLE_DB` would 500 every DB-backed route in production.
				// Create the configs against the EU PlanetScale database (one per
				// consumer, like prd's) and put their ids here.
				throw new Error(
					`No Hyperdrive config for the EU instance yet (consumer "${consumer}"). Create maple-prd-eu / maple-alerting-prd-eu in the dashboard and add the ids to resolveHyperdriveRefId.`,
				)
			}
			// Both target the PlanetScale `main` branch; their `origin_connection_limit`s
			// SUM against its `max_connections`.
			// TODO(ai-worker): `ai` shares `maple-prd` until a dedicated
			// `maple-ai-prd` config exists in the dashboard. It must be created
			// before maple-ai serves prd traffic — the agents are the heaviest
			// Postgres readers after alerting, and sharing api's pool is how the
			// api's connections got starved before alerting got its own.
			return consumer === "alerting"
				? "f473167201af4d2cae494f9989f1d742" // `maple-alerting-prd`
				: "ad4c487838594b89810b23e5fb14e129" // `maple-prd`
		case "pr":
		case "dev":
			return undefined
	}
}

/**
 * Physical Worker (and bucket, and Hyperdrive) name. The region suffix sits
 * right after the base, mirroring `resolveAwsResourceName`, so `maple-api`,
 * `maple-api-eu`, `maple-api-eu-dev-makisuo` read the same in both consoles.
 * `us` carries no suffix — see `MapleRegion`.
 */
export function resolveWorkerName(
	base: string,
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	const suffix = regionSuffix(region)
	switch (stage.kind) {
		case "prd":
			return `maple-${base}${suffix}`
		case "pr":
			return `maple-${base}${suffix}-pr-${stage.prNumber}`
		case "dev":
			return `maple-${base}${suffix}-dev-${stage.name}`
	}
}
