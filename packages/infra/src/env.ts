import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { optionalString } from "./config-helpers.ts"
import type { MapleDomains, MapleStage } from "./cloudflare/stage.ts"
import { PRD_DOMAINS, prdOrigin, resolveDeploymentEnvironment } from "./cloudflare/stage.ts"
import { DEFAULT_MAPLE_REGION, type MapleRegion } from "./region.ts"
import { Array as Arr, String as Str } from "effect"

/**
 * Deploy-time Worker env, as effect `Config`s: never read `process.env`, which misses alchemy's
 * `.env` / `--env-file` provider. Values are trimmed (blank = absent), absent optional keys are
 * omitted (never `""`), and secrets are `Redacted`.
 */

export type PlainEnv = Record<string, string>
export type SecretEnv = Record<string, Redacted.Redacted>
/** A union-valued record, not `PlainEnv & SecretEnv` (that intersection is uninhabited). */
export type WorkerEnv = Record<string, string | Redacted.Redacted>

/** Present-and-non-blank, trimmed (`optionalString` returns the raw value). */
const trimmedOption = (key: string): Config.Config<Option.Option<string>> =>
	optionalString(key).pipe(
		Config.map((value: Option.Option<string>) => Option.map(value, (raw) => Str.trim(raw))),
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
export const requiredSecret = (key: string): Config.Config<Redacted.Redacted> =>
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
			const resolved =
				Option.getOrUndefined(value) ?? (fallback === undefined ? undefined : Str.trim(fallback))
			return resolved ? { [key]: resolved } : {}
		}),
	)

/** Optional secret, omitted when unset. */
export const optionalSecret = (key: string): Config.Config<SecretEnv> =>
	trimmedOption(key).pipe(Config.map((value) => entry(key, Option.map(value, Redacted.make))))

/** The first present-and-non-blank of `keys`, else `fallback`. For build vars with a `VITE_` twin. */
export const plainFrom = (keys: ReadonlyArray<string>, fallback: string): Config.Config<string> =>
	Config.all(Arr.map(keys, trimmedOption)).pipe(
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

/**
 * The deployed revision: the first set of `preferred`, `COMMIT_SHA`, `GITHUB_SHA`, else `""`. An
 * unstamped build makes the error evaluator reopen fixed issues on any occurrence.
 */
export const commitSha = (...preferred: ReadonlyArray<string>): Config.Config<string> =>
	plainFrom([...preferred, "COMMIT_SHA", "GITHUB_SHA"], "")

/** {@link commitSha} as `{ COMMIT_SHA }`, omitted when unknown. */
export const commitShaEnv = (...preferred: ReadonlyArray<string>): Config.Config<PlainEnv> =>
	commitSha(...preferred).pipe(Config.map((sha): PlainEnv => (sha === "" ? {} : { COMMIT_SHA: sha })))

/** The one sender address notification emails use; the `send_email` binding allows only it. */
export const NOTIFICATIONS_SENDER_ADDRESS = "notifications@noreply.maple.dev"

// ── Shared groups ───────────────────────────────────────────────────────────

/**
 * Dev only: on a deploy a pin would point every session at one tenant. The local stack's pin names
 * a seeded org the dev user is not a member of, so it admits non-members.
 */
export const devOrgOverrideEnv = (stage: MapleStage): Config.Config<WorkerEnv> =>
	stage.kind === "dev"
		? merge(
				optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
				plainWithDefault("MAPLE_ORG_ID_OVERRIDE_ADMITS_NONMEMBERS", "true"),
			)
		: merge()

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
		// Derived where the deploy has its own gateway: a preview must hand out its own endpoint.
		domains.ingest
			? derived("MAPLE_INGEST_PUBLIC_URL", `https://${domains.ingest}`)
			: plainWithDefault("MAPLE_INGEST_PUBLIC_URL", prdOrigin("ingest")),
		plainWithDefault("MAPLE_APP_BASE_URL", `https://${domains.web ?? PRD_DOMAINS.web}`),
		// Canonical API origin for self-published URLs (MCP `server.json`, email one-click
		// unsubscribe), never forwarded headers.
		domains.api
			? derived("MAPLE_API_BASE_URL", `https://${domains.api}`)
			: plainWithDefault("MAPLE_API_BASE_URL", prdOrigin("api")),
		plainWithDefault("EMAIL_FROM", `Maple <${NOTIFICATIONS_SENDER_ADDRESS}>`),
	)

/** The Worker's own OTLP export, stamped with its revision ({@link commitShaEnv}). */
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
		// Read for Durable Object jurisdiction (`layerChatSessions`).
		derived("MAPLE_REGION", region),
		// Tells the instances apart in the shared internal org.
		derived("OTEL_RESOURCE_ATTRIBUTES", `maple.region=${region}`),
		commitShaEnv(),
	)

/**
 * prd services deployed together that must report the same revision. Not ingest: it reports
 * the last commit that touched `apps/ingest` (`INGEST_COMMIT_SHA`). The "Prod revision skew"
 * alert rule (id `2a6e9529-5f73-4478-9fa0-432904ff15c8`) lives in the Maple database, not this
 * repo: if you change this list, you MUST edit that rule's SQL to match.
 */
export const PRD_LOCKSTEP_REVISION_SERVICES = [
	"alerting",
	"maple-ai",
	"electric-sync",
	"maple-api",
	"maple-web",
] as const

/** Each declared config key as an optional plain value or secret; unset means unavailable. */
export const configKeysEnv = (
	keys: ReadonlyArray<{ readonly name: string; readonly secret: boolean }>,
): Config.Config<WorkerEnv> =>
	merge(...Arr.map(keys, (key) => (key.secret ? optionalSecret(key.name) : optionalPlain(key.name))))

/** Linear OAuth client: api installs it, alerting refreshes the org's token at delivery time. */
export const linearOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("LINEAR_OAUTH_CLIENT_ID"),
	optionalSecret("LINEAR_OAUTH_CLIENT_SECRET"),
)

/** Google Search Console OAuth client: api connects, alerting's importer refreshes, maple-ai reports it. */
export const searchConsoleOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("GOOGLE_SEARCH_CONSOLE_CLIENT_ID"),
	optionalSecret("GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET"),
)

/**
 * What every Worker running Maple's service graph (api, maple-ai, alerting) reads: warehouse,
 * auth, ingest-key crypto, public URLs, self-telemetry, billing, the internal service token and
 * the GitHub App and Search Console clients. MAPLE_ENVIRONMENT stays stage-derived: it gates the
 * non-prod cron skip and `EmailService.emailAllowed`.
 */
export const mapleServerEnv = (
	stage: MapleStage,
	region: MapleRegion,
	domains: MapleDomains,
): Config.Config<WorkerEnv> =>
	merge(
		tinybirdEnv,
		authEnv,
		ingestKeyCryptoEnv,
		appUrlsEnv(domains),
		selfObservabilityEnv(stage, region),
		// Dev-only; the runtime ignores it outside MAPLE_ENVIRONMENT=development.
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
		// Without it billing and the BYOK entitlement fail open.
		optionalSecret("AUTUMN_SECRET_KEY"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		githubAppSourceEnv,
		searchConsoleOAuthEnv,
	)

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

/** Supabase integration (Management API OAuth app: confidential client with PKCE). */
export const supabaseOAuthEnv: Config.Config<WorkerEnv> = merge(
	optionalPlain("SUPABASE_OAUTH_CLIENT_ID"),
	optionalSecret("SUPABASE_OAUTH_CLIENT_SECRET"),
	optionalPlain("MAPLE_SUPABASE_API_BASE_URL"),
)

/**
 * The GitHub App as a repository reader, for api, maple-ai and alerting. The install flow's client
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
	// App Attest for device credentials: App ID = <APNS_TEAM_ID>.<MAPLE_IOS_BUNDLE_ID>.
	optionalPlain("MAPLE_IOS_BUNDLE_ID"),
	optionalPlain("MAPLE_APP_ATTEST_ALLOW_DEVELOPMENT"),
)
