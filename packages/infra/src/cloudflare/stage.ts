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
	/** Self-hosted ElectricSQL (`apps/electric`). Public, but guarded by `ELECTRIC_SECRET`. */
	electric?: string
	/** Auto-updating local-mode dashboard SPA (the `maple` binary points users here by default). */
	local?: string
	/**
	 * The chat-bot Worker's webhook host. Must stay stable: chat platforms configure it once and
	 * every workspace re-approves on change. prd only.
	 */
	chat?: string
}

/**
 * Best-effort Worker placement beside the instance's database and Tinybird workspace. Not a
 * residency guarantee; storage jurisdiction is ({@link resolveStorageJurisdiction}).
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
 * The R2 / Durable Object jurisdiction (a hard guarantee), or `undefined` for the default.
 * Fixed at creation: an existing bucket cannot move.
 */
export function resolveStorageJurisdiction(region: MapleRegion): "eu" | undefined {
	return region === "eu" ? "eu" : undefined
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

/** EU hostnames under `eu.maple.dev`. No landing or local-ui (shared apps run in `us` only). */
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

	// Rejected explicitly: these would otherwise match the dev-stage pattern.
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
		// Cloudflare names allow only [a-z0-9-].
		return Result.succeed({ kind: "dev", name: normalized.replaceAll("_", "-") })
	}

	return Result.fail(
		new MapleStageError({
			message: `Unsupported deployment stage "${stage}". Expected prd, pr-<number>, or a dev stage name matching [a-z0-9][a-z0-9_-]*.`,
			rawStage: stage,
		}),
	)
}

/** Parse a stage name; throws the `MapleStageError`. For non-Effect callers only. */
export function parseMapleStage(stage: string): MapleStage {
	return Result.getOrThrow(mapleStageResult(stage))
}

/**
 * The stage string names stage and instance (`prd-eu`, `dev_makisuo-eu`); alchemy keys state by
 * stage, so instances never share a plan. A `-eu` suffix always means the region. PR previews are US-only.
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

/** Synchronous {@link parseMapleDeploymentEffect}: throws the `MapleStageError`. For non-Effect callers only. */
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

/** A deployment's public hostnames. Dev stages have none: they run through portless. */
export function resolveMapleDomains({ stage, region }: MapleDeployment): MapleDomains {
	switch (stage.kind) {
		case "prd":
			return region === "eu" ? PRD_DOMAINS_EU : PRD_DOMAINS
		case "pr":
			// Previews are `us` only (`parseMapleDeployment` rejects the rest); never hand
			// another region the US preview hostnames.
			if (region !== DEFAULT_MAPLE_REGION) return {}
			// Custom domains, not workers.dev: its account subdomain is masked as a secret
			// (GitHub then rejects the env URL), and inter-app URLs must be plan-time strings.
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

/** Every regional instance's dashboard URL (prd only), for cross-region org redirects. */
export function resolveRegionAppUrls(stage: MapleStage): Partial<Record<MapleRegion, string>> {
	if (stage.kind !== "prd") return {}
	return Object.fromEntries(
		MAPLE_REGIONS.map((region) => [region, `https://${resolveMapleDomains({ stage, region }).web}`]),
	)
}

/** The instance's PlanetScale database, created by hand and adopted by name; everything on it is declared. */
export function resolvePlanetscaleDatabase(region: MapleRegion = DEFAULT_MAPLE_REGION): string {
	return `maple${regionSuffix(region)}`
}

/** Which worker is binding `MAPLE_DB`. prd gives each its own Hyperdrive config — see docs/infra.md. */
export type MapleDbConsumer = "api" | "ai" | "alerting" | "chat-bot"

/** Dashboard-managed Hyperdrive config ids for the `"ref"` mode (US prd). Not secrets. */
export function resolveHyperdriveRefId(stage: MapleStage, consumer: MapleDbConsumer): string | undefined {
	switch (stage.kind) {
		case "prd":
			// Their `origin_connection_limit`s SUM against `main`'s `max_connections`.
			// TODO(ai-worker): create a dedicated `maple-ai-prd` config before maple-ai
			// serves prd traffic; sharing api's pool starves api.
			return consumer === "alerting"
				? "f473167201af4d2cae494f9989f1d742" // `maple-alerting-prd`
				: "ad4c487838594b89810b23e5fb14e129" // `maple-prd`
		case "pr":
		case "dev":
			return undefined
	}
}

/** Physical Worker/bucket/Hyperdrive name, e.g. `maple-api-eu-dev-makisuo`; mirrors `resolveAwsResourceName`. */
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
