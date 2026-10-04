import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
	DEFAULT_MAPLE_REGION,
	isMapleRegion,
	MAPLE_REGIONS,
	type MapleRegion,
	regionSuffix,
} from "../region.ts"

/** An alchemy stage string that names no deployable Maple stage or instance. */
export class MapleStageError extends Schema.TaggedError<MapleStageError>()("@maple/infra/MapleStageError", {
	message: Schema.String,
	rawStage: Schema.String,
}) {}

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
	/**
	 * The chat-bot Worker (`apps/chat-bot`).
	 *
	 * It exists for exactly one reason: a chat platform that delivers its events as signed HTTP
	 * requests needs a URL to deliver them TO, and that URL is configured once inside a vendor's
	 * app and re-approved by every workspace when it changes. So it is a stable custom domain
	 * rather than a `workers.dev` URL, which carries the Cloudflare account subdomain.
	 *
	 * Only production instances get one. A dev stage reaches the same route through portless, and
	 * a PR preview has no chat app of its own to point at it.
	 */
	chat?: string
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
	chat: "chat.maple.dev",
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
	chat: "chat.eu.maple.dev",
}

const mapleStageResult = (stage: string): Result.Result<MapleStage, MapleStageError> => {
	const normalized = stage.trim().toLowerCase()

	if (normalized === "prd") {
		return Result.succeed({ kind: "prd" })
	}

	// These are rejected rather than left to fall through to the dev-stage
	// pattern, which they all match. The staging stage was removed (2026-09) after
	// sitting disabled and unreachable with its Hyperdrive ref pointed at the
	// production database; a `--stage stg` that quietly built a dev stack named
	// `maple-*-dev-stg` is not the failure anyone typing it wants — and someone
	// typing it from memory is as likely to write `staging`.
	if (REMOVED_STAGE_NAMES.has(normalized)) {
		return Result.fail(
			new MapleStageError({
				message: `The "${normalized}" stage was removed. Deploy prd, a pr-<number> preview, or a dev stage name.`,
				rawStage: stage,
			}),
		)
	}

	const prMatch = normalized.match(PR_STAGE_RE)
	if (prMatch) {
		const prNumber = Number(prMatch[1])
		if (Number.isSafeInteger(prNumber) && prNumber > 0) {
			return Result.succeed({ kind: "pr", prNumber })
		}
	}

	if (DEV_STAGE_RE.test(normalized)) {
		// Underscores are accepted (alchemy's default stage is `dev_${USER}`) but
		// normalized to hyphens: `name` flows into Cloudflare worker/Hyperdrive
		// names, which only allow [a-z0-9-].
		return Result.succeed({ kind: "dev", name: normalized.replaceAll("_", "-") })
	}

	return Result.fail(
		new MapleStageError({
			message: `Unsupported deployment stage "${stage}". Expected prd, pr-<number>, or a dev stage name matching [a-z0-9][a-z0-9_-]*.`,
			rawStage: stage,
		}),
	)
}

/** Parse a stage name, failing with {@link MapleStageError}. */
export const parseMapleStageEffect = (stage: string): Effect.Effect<MapleStage, MapleStageError> =>
	Effect.fromResult(mapleStageResult(stage))

/** Synchronous {@link parseMapleStageEffect}: throws the `MapleStageError`. For non-Effect callers only. */
export function parseMapleStage(stage: string): MapleStage {
	return Result.getOrThrow(mapleStageResult(stage))
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
const mapleDeploymentResult = (raw: string): Result.Result<MapleDeployment, MapleStageError> => {
	const normalized = raw.trim().toLowerCase()
	const match = normalized.match(REGION_STAGE_SUFFIX_RE)
	const suffix = match?.[1]
	const region: MapleRegion = suffix !== undefined && isMapleRegion(suffix) ? suffix : DEFAULT_MAPLE_REGION
	return Result.flatMap(
		mapleStageResult(match ? normalized.slice(0, -match[0].length) : normalized),
		(stage): Result.Result<MapleDeployment, MapleStageError> =>
			stage.kind === "pr" && region !== DEFAULT_MAPLE_REGION
				? Result.fail(
						new MapleStageError({
							message: `PR previews deploy to the ${DEFAULT_MAPLE_REGION} instance only; "${raw}" asks for "${region}".`,
							rawStage: raw,
						}),
					)
				: Result.succeed({ stage, region }),
	)
}

/** Parse an alchemy stage string, failing with {@link MapleStageError}. */
export const parseMapleDeploymentEffect = (raw: string): Effect.Effect<MapleDeployment, MapleStageError> =>
	Effect.fromResult(mapleDeploymentResult(raw))

/**
 * Synchronous {@link parseMapleDeploymentEffect}: throws the `MapleStageError`.
 * For non-Effect callers only; Effect code uses the Effect variant.
 */
export function parseMapleDeployment(raw: string): MapleDeployment {
	return Result.getOrThrow(mapleDeploymentResult(raw))
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

const mapleDomainsResult = (
	stage: MapleStage,
	region: MapleRegion,
): Result.Result<MapleDomains, MapleStageError> => {
	switch (stage.kind) {
		case "prd":
			return Result.succeed(region === "eu" ? PRD_DOMAINS_EU : PRD_DOMAINS)
		case "pr":
			if (region !== DEFAULT_MAPLE_REGION) {
				return Result.fail(
					new MapleStageError({
						message: `PR previews have no ${region} hostnames; see parseMapleDeployment.`,
						rawStage: formatMapleDeployment({ stage, region }),
					}),
				)
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
			return Result.succeed({
				web: `app-pr-${stage.prNumber}.maple.dev`,
				api: `api-pr-${stage.prNumber}.maple.dev`,
				sync: `sync-pr-${stage.prNumber}.maple.dev`,
				landing: `landing-pr-${stage.prNumber}.maple.dev`,
			})
		case "dev":
			return Result.succeed({})
	}
}

/** A deployment's public hostnames, failing with {@link MapleStageError} for a PR preview outside `us`. */
export const resolveMapleDomainsEffect = (
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): Effect.Effect<MapleDomains, MapleStageError> => Effect.fromResult(mapleDomainsResult(stage, region))

/** Synchronous {@link resolveMapleDomainsEffect}: throws the `MapleStageError`. For non-Effect callers only. */
export function resolveMapleDomains(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): MapleDomains {
	return Result.getOrThrow(mapleDomainsResult(stage, region))
}

/**
 * Every regional instance's dashboard URL, so the web app can send an organization that lives
 * elsewhere to its own region. Only prd has more than one instance; other stages get none.
 */
export function resolveRegionAppUrls(stage: MapleStage): Partial<Record<MapleRegion, string>> {
	if (stage.kind !== "prd") return {}
	return Object.fromEntries(
		MAPLE_REGIONS.map((region) => [region, `https://${resolveMapleDomains(stage, region).web}`]),
	)
}

export type MapleDatabaseMode = "ref" | "declared" | "managed" | "none"

/**
 * How a stage reaches the application database.
 *
 * - `"ref"` — bind a dashboard-managed Hyperdrive config by ID (the US prd).
 * - `"declared"` — the deploy declares the database roles and their Hyperdrive
 *   configs on the instance's branch, one per consumer, and the Workers bind
 *   them from their props (the EU prd; `resolvePlanetscaleDatabase` names the
 *   database). Both prd modes adopt the branch and apply the migrations.
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
export function resolveDatabaseMode(
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): MapleDatabaseMode {
	switch (stage.kind) {
		case "prd":
			return region === DEFAULT_MAPLE_REGION ? "ref" : "declared"
		case "pr":
			return "none"
		case "dev":
			return "managed"
	}
}

/** Whether the deploy adopts the instance's PlanetScale branch and applies the migrations. */
export function stageMigratesDatabase(mode: MapleDatabaseMode): boolean {
	return mode === "ref" || mode === "declared"
}

/** The instance's PlanetScale database, created by hand and adopted by name; everything on it is declared. */
export function resolvePlanetscaleDatabase(region: MapleRegion = DEFAULT_MAPLE_REGION): string {
	return `maple${regionSuffix(region)}`
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
export type MapleDbConsumer = "api" | "ai" | "alerting" | "chat-bot"

/**
 * Dashboard-managed Hyperdrive configs, bound by ID; deploys never see the
 * database credentials. The `"ref"` mode's half of `MapleDb`, so only the US
 * prd answers; every other stage gets its config from the deploy (`"declared"`,
 * `"managed"`) or none — `resolveDatabaseMode` decides. Config IDs are not secrets.
 */
export function resolveHyperdriveRefId(stage: MapleStage, consumer: MapleDbConsumer): string | undefined {
	switch (stage.kind) {
		case "prd":
			// Both target the PlanetScale `main` branch; their `origin_connection_limit`s
			// SUM against its `max_connections`.
			// TODO(ai-worker): `ai` shares `maple-prd` until a dedicated
			// `maple-ai-prd` config exists in the dashboard. It must be created
			// before maple-ai serves prd traffic — the agents are the heaviest
			// Postgres readers after alerting, and sharing api's pool is how the
			// api's connections got starved before alerting got its own.
			// `chat-bot` shares it on different grounds: one row per mention is
			// not a pool's worth of traffic.
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
