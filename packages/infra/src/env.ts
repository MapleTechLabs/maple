import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { optionalString } from "./config-helpers.ts"
import type { MapleDomains, MapleStage } from "./cloudflare/stage.ts"
import { resolveDeploymentEnvironment } from "./cloudflare/stage.ts"
import { DEFAULT_MAPLE_REGION, type MapleRegion } from "./region.ts"

/**
 * Deploy-time Worker env, as effect `Config`s: never read `process.env`, which misses alchemy's
 * `.env` / `--env-file` provider. Values are trimmed (blank = absent), absent optional keys are
 * omitted (never `""`), and secrets are `Redacted`.
 */

export type PlainEnv = Record<string, string>
export type SecretEnv = Record<string, Redacted.Redacted<string>>
/** A union-valued record, not `PlainEnv & SecretEnv` (that intersection is uninhabited). */
export type WorkerEnv = Record<string, string | Redacted.Redacted<string>>

/** Present-and-non-blank, trimmed (`optionalString` returns the raw value). */
const trimmedOption = (key: string): Config.Config<Option.Option<string>> =>
	optionalString(key).pipe(
		Config.map((value: Option.Option<string>) => Option.map(value, (raw) => raw.trim())),
	)

const entry = <A>(key: string, value: Option.Option<A>): Record<string, A> =>
	Option.match(value, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) })

/** Merge several partial-record configs into one. */
export const merge = (...parts: ReadonlyArray<Config.Config<Partial<WorkerEnv>>>): Config.Config<WorkerEnv> =>
	Config.all(parts).pipe(
		Config.map(
			(records: ReadonlyArray<Partial<WorkerEnv>>) => Object.assign({}, ...records) as WorkerEnv,
		),
	)

/** Required plain value, trimmed; blank fails with a `ConfigError`. */
export const requiredPlain = (key: string): Config.Config<string> =>
	Config.schema(Schema.Trim.check(Schema.isNonEmpty()), key)

/** Required secret, wrapped in `Redacted`. */
export const requiredSecret = (key: string): Config.Config<Redacted.Redacted<string>> =>
	requiredPlain(key).pipe(Config.map(Redacted.make))

/** Required plain value as a single-entry record, for spreading into a group. */
export const requirePlainEntry = (key: string): Config.Config<PlainEnv> =>
	requiredPlain(key).pipe(Config.map((value) => ({ [key]: value })))

/** Required secret as a single-entry record. */
export const requireSecretEntry = (key: string): Config.Config<SecretEnv> =>
	requiredSecret(key).pipe(Config.map((value) => ({ [key]: value })))

/** Optional plain value, omitted when unset. `fallback` applies only if the key is absent. */
export const optionalPlain = (key: string, fallback?: string): Config.Config<PlainEnv> =>
	trimmedOption(key).pipe(
		Config.map((value) => {
			const resolved = Option.getOrUndefined(value) ?? fallback?.trim()
			return resolved ? { [key]: resolved } : {}
		}),
	)

/** Optional secret, omitted when unset. */
export const optionalSecret = (key: string): Config.Config<SecretEnv> =>
	trimmedOption(key).pipe(Config.map((value) => entry(key, Option.map(value, Redacted.make))))

/** The first present-and-non-blank of `keys`, else `fallback`. For build vars with a `VITE_` twin. */
export const plainFrom = (keys: ReadonlyArray<string>, fallback: string): Config.Config<string> =>
	Config.all(keys.map(trimmedOption)).pipe(
		Config.map((values: ReadonlyArray<Option.Option<string>>) =>
			Option.getOrElse(Option.firstSomeOf(values), () => fallback),
		),
	)

/** Optional value whose default also applies to a BLANK var (unlike `Config.withDefault`). */
export const plainWithDefault = (key: string, fallback: string): Config.Config<PlainEnv> =>
	trimmedOption(key).pipe(Config.map((value) => ({ [key]: Option.getOrElse(value, () => fallback) })))

/**
 * A value the stack chooses; the environment cannot override it. Load-bearing for
 * `MAPLE_ENVIRONMENT`: a stray `production` on a preview would enable emails and alerting crons.
 */
export const derived = (key: string, value: string): Config.Config<PlainEnv> =>
	Config.succeed({ [key]: value })

// ── Shared groups ───────────────────────────────────────────────────────────

/** Session auth, shared by `api`, `alerting` and `electric-sync`. */
export const authEnv: Config.Config<WorkerEnv> = merge(
	plainWithDefault("MAPLE_AUTH_MODE", "self_hosted"),
	derived("CLERK_TELEMETRY_DISABLED", "1"),
	plainWithDefault("MAPLE_DEFAULT_ORG_ID", "default"),
	optionalSecret("MAPLE_ROOT_PASSWORD"),
	optionalSecret("CLERK_SECRET_KEY"),
	optionalPlain("CLERK_PUBLISHABLE_KEY"),
	optionalSecret("CLERK_JWT_KEY"),
)

/** Warehouse access. `SIGNING_KEY` + `WORKSPACE_ID` are required for raw-SQL alerts too. */
export const tinybirdEnv: Config.Config<WorkerEnv> = merge(
	requirePlainEntry("TINYBIRD_HOST"),
	requireSecretEntry("TINYBIRD_TOKEN"),
	optionalSecret("TINYBIRD_SIGNING_KEY"),
	optionalPlain("TINYBIRD_WORKSPACE_ID"),
	optionalPlain("TINYBIRD_RAW_SQL_JWT_RPS_LIMIT"),
)

/** Ingest-key envelope encryption + lookup HMAC. Required wherever ingest keys are read. */
export const ingestKeyCryptoEnv: Config.Config<WorkerEnv> = merge(
	requireSecretEntry("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
	requireSecretEntry("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
)

/** Public URLs for links, defaulting to the deploy's own hostnames (else production's). */
export const appUrlsEnv = (domains: MapleDomains = {}): Config.Config<WorkerEnv> =>
	merge(
		plainWithDefault("MAPLE_INGEST_PUBLIC_URL", `https://${domains.ingest ?? "ingest.maple.dev"}`),
		plainWithDefault("MAPLE_APP_BASE_URL", `https://${domains.web ?? "app.maple.dev"}`),
		plainWithDefault("EMAIL_FROM", "Maple <notifications@noreply.maple.dev>"),
	)

/**
 * The Worker's own OTLP export. `COMMIT_SHA` falls back to `GITHUB_SHA`: an unstamped build
 * makes the error evaluator reopen fixed issues on any occurrence.
 */
export const selfObservabilityEnv = (
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): Config.Config<WorkerEnv> =>
	merge(
		// Optional on dev only (absent = self-observability off). Rebound as MAPLE_INGEST_KEY.
		stage.kind === "dev"
			? optionalSecret("MAPLE_OTEL_INGEST_KEY").pipe(
					Config.map((record) =>
						"MAPLE_OTEL_INGEST_KEY" in record
							? { MAPLE_INGEST_KEY: record.MAPLE_OTEL_INGEST_KEY }
							: {},
					),
				)
			: requiredSecret("MAPLE_OTEL_INGEST_KEY").pipe(
					Config.map((value) => ({ MAPLE_INGEST_KEY: value })),
				),
		optionalPlain("MAPLE_ENDPOINT"),
		derived("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
		// Read for Durable Object jurisdiction (`chatSessionsLayer`).
		derived("MAPLE_REGION", region),
		// Tells the instances apart in the shared internal org.
		derived("OTEL_RESOURCE_ATTRIBUTES", `maple.region=${region}`),
		// Read via Config, not `process.env`, so `.env` / `--env-file` apply.
		merge(optionalPlain("COMMIT_SHA"), optionalPlain("GITHUB_SHA")).pipe(
			Config.map((record): PlainEnv => {
				const sha = record.COMMIT_SHA ?? record.GITHUB_SHA
				return typeof sha === "string" && sha ? { COMMIT_SHA: sha } : {}
			}),
		),
	)

/**
 * prd services deployed together that must report the same revision. The "Prod revision skew"
 * alert rule (id `2a6e9529-5f73-4478-9fa0-432904ff15c8`) lives in the Maple database, not this
 * repo: if you change this list, you MUST edit that rule's SQL to match.
 */
export const PRD_LOCKSTEP_REVISION_SERVICES = [
	"alerting",
	"maple-ai",
	"electric-sync",
	"ingest",
	"maple-api",
	"maple-web",
] as const

/** Cloudflare account integration (account OAuth — Authorization Code + PKCE). */
export const cloudflareOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("CLOUDFLARE_OAUTH_CLIENT_ID"),
	optionalSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
	optionalPlain("CLOUDFLARE_OAUTH_SCOPES"),
	optionalPlain("CLOUDFLARE_OAUTH_AUTHORIZE_URL"),
	optionalPlain("CLOUDFLARE_OAUTH_TOKEN_URL"),
	optionalPlain("CLOUDFLARE_OAUTH_REVOKE_URL"),
	optionalPlain("MAPLE_CLOUDFLARE_API_BASE_URL"),
)

/** PlanetScale integration (OAuth application — confidential client, no PKCE). */
export const planetScaleOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("PLANETSCALE_OAUTH_CLIENT_ID"),
	optionalSecret("PLANETSCALE_OAUTH_CLIENT_SECRET"),
	optionalPlain("PLANETSCALE_OAUTH_AUTHORIZE_URL"),
	optionalPlain("PLANETSCALE_OAUTH_TOKEN_URL"),
	optionalPlain("PLANETSCALE_OAUTH_TOKEN_INFO_URL"),
	optionalPlain("MAPLE_PLANETSCALE_API_BASE_URL"),
)

/**
 * The GitHub App as a repository reader, for api and maple-ai. The install flow's client
 * id/secret and the webhook secret stay api-only.
 */
export const githubAppSourceEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("GITHUB_APP_ID"),
	optionalPlain("GITHUB_APP_SLUG"),
	optionalSecret("GITHUB_APP_PRIVATE_KEY"),
	optionalPlain("GITHUB_API_BASE_URL"),
)

/** Apple push (iOS app) — token auth; see `packages/backend/src/platform/Apns.ts`. */
export const apnsEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("APNS_TEAM_ID"),
	optionalPlain("APNS_KEY_ID"),
	optionalSecret("APNS_PRIVATE_KEY"),
)
