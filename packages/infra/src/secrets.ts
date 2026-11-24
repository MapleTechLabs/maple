// The catalog of Maple's own deployment secrets. Export only secret classes: `secret-guard.ts`
// reads the module's exports as the list. Not here: credentials a deploy mints itself, the chat
// connectors' config keys (`@maple/chat-platform`) and the deploy tooling's own credentials.
import { Secret, type SecretEnvironment } from "./secret.ts"

// Prod-issued credentials with no dev or preview copy yet. Give an environment its own credential,
// then list it on that secret: a preview runs the PR's own code.
const PRD_ONLY = ["prod", "prod-eu"] satisfies ReadonlyArray<SecretEnvironment>

// Database URLs (each carries its role's password)

export class MaplePgUrl extends Secret<MaplePgUrl>()("MAPLE_PG_URL", {
	issuer: "postgres",
	consumers: ["managed-db"],
}) {}

// Warehouse

// A preview deploys on its branch's token (docs/pr-previews.md), never prod's. The parent workspace
// token that creates branches is a GitHub environment secret, so no dev copy of prod's exists.
// ingest gets only the append token its deploy reads with this one (`maple_ingest_append`).
export class TinybirdToken extends Secret<TinybirdToken>()("TINYBIRD_TOKEN", {
	issuer: "tinybird",
	consumers: ["api", "ai", "alerting"],
	derivedFor: ["ingest"],
}) {}

// Deletes a deleted organization's rows. The narrowest token that can delete rows is workspace-wide
// (`DATASOURCES:CREATE`), so only the org-eraser Worker, which serves no requests, binds it.
export class WarehouseDeleteToken extends Secret<WarehouseDeleteToken>()("TINYBIRD_DELETE_TOKEN", {
	issuer: "tinybird",
	consumers: ["org-eraser"],
	environments: PRD_ONLY,
}) {}

export class TinybirdSigningKey extends Secret<TinybirdSigningKey>()("TINYBIRD_SIGNING_KEY", {
	issuer: "tinybird",
	consumers: ["api", "ai", "alerting"],
}) {}

export class ClickhousePassword extends Secret<ClickhousePassword>()("CLICKHOUSE_PASSWORD", {
	issuer: "clickhouse",
	consumers: ["api", "ai", "alerting"],
}) {}

/** The Cloudflare Access service token secret in front of an env-level ClickHouse. */
export class ClickhouseAccessClientSecret extends Secret<ClickhouseAccessClientSecret>()(
	"CLICKHOUSE_ACCESS_CLIENT_SECRET",
	{
		issuer: "cloudflare-access",
		consumers: ["api", "ai", "alerting"],
	},
) {}

// Session auth

export class MapleRootPassword extends Secret<MapleRootPassword>()("MAPLE_ROOT_PASSWORD", {
	issuer: "maple",
	consumers: ["api", "ai", "alerting", "electric-sync"],
}) {}

/** Optional key self-hosted session tokens are signed from, so a token does not expose the root password. */
export class MapleSessionSigningSecret extends Secret<MapleSessionSigningSecret>()(
	"MAPLE_SESSION_SIGNING_SECRET",
	{
		issuer: "maple",
		consumers: ["api", "ai", "alerting", "electric-sync"],
	},
) {}

export class ClerkSecretKey extends Secret<ClerkSecretKey>()("CLERK_SECRET_KEY", {
	issuer: "clerk",
	consumers: ["api", "ai", "alerting", "electric-sync"],
}) {}

export class ClerkJwtKey extends Secret<ClerkJwtKey>()("CLERK_JWT_KEY", {
	issuer: "clerk",
	consumers: ["api", "ai", "alerting", "electric-sync"],
}) {}

export class ClerkWebhookSecret extends Secret<ClerkWebhookSecret>()("CLERK_WEBHOOK_SECRET", {
	issuer: "clerk",
	consumers: ["api"],
	// A preview holding it could sign events that prd accepts.
	environments: ["dev", "prod", "prod-eu"],
}) {}

export class PreviewSigninKey extends Secret<PreviewSigninKey>()("PREVIEW_SIGNIN_KEY", {
	issuer: "maple",
	consumers: ["api"],
	environments: ["dev", "preview"],
}) {}

// Keys every reader of the same ciphertext or token must share (docs/secret-encryption.md)

export class IngestKeyEncryptionKey extends Secret<IngestKeyEncryptionKey>()(
	"MAPLE_INGEST_KEY_ENCRYPTION_KEY",
	// ingest gets only its ClickHouse password slot keys (secret-slot-keys.ts).
	{ issuer: "maple", consumers: ["api", "ai", "alerting", "chat-bot"], derivedFor: ["ingest"] },
) {}

export class IngestKeyDecryptionKeys extends Secret<IngestKeyDecryptionKeys>()(
	"MAPLE_INGEST_KEY_DECRYPTION_KEYS",
	{ issuer: "maple", consumers: ["api", "ai", "alerting", "chat-bot"], derivedFor: ["ingest"] },
) {}

export class IngestKeyLookupHmacKey extends Secret<IngestKeyLookupHmacKey>()(
	"MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
	{ issuer: "maple", consumers: ["api", "ai", "alerting", "ingest"] },
) {}

export class ShareTokenHmacKey extends Secret<ShareTokenHmacKey>()("MAPLE_SHARE_TOKEN_HMAC_KEY", {
	issuer: "maple",
	consumers: ["api", "alerting", "chat-bot"],
}) {}

// Service-to-service tokens

export class InternalServiceToken extends Secret<InternalServiceToken>()("INTERNAL_SERVICE_TOKEN", {
	issuer: "maple",
	consumers: ["api", "ai", "alerting"],
}) {}

export class SandboxInternalServiceToken extends Secret<SandboxInternalServiceToken>()(
	"SANDBOX_INTERNAL_SERVICE_TOKEN",
	{ issuer: "maple", consumers: ["ai", "sandbox"] },
) {}

export class ScraperInternalToken extends Secret<ScraperInternalToken>()("SD_INTERNAL_TOKEN", {
	issuer: "maple",
	consumers: ["api", "scraper"],
}) {}

export class ElectricSecret extends Secret<ElectricSecret>()("ELECTRIC_SECRET", {
	issuer: "maple",
	consumers: ["electric-sync", "electric"],
}) {}

// Maple's own telemetry

export class OtelIngestKey extends Secret<OtelIngestKey>()("MAPLE_OTEL_INGEST_KEY", {
	issuer: "maple",
	consumers: [
		"api",
		"audit-archive",
		"ai",
		"alerting",
		"org-eraser",
		"chat-bot",
		"electric-sync",
		"status",
		"web",
		"scraper",
		"workers-observability",
	],
	boundAs: "MAPLE_INGEST_KEY",
	// Write-only, into Maple's own org: every stage reports there, told apart by environment.
	sharesProdValueWith: ["dev", "preview"],
}) {}

// Uploads the dashboard's source maps into Maple's own org at deploy (`source_maps:write` only). Prd
// alone: dev and preview builds upload nothing.
export class MapleSourceMapsApiKey extends Secret<MapleSourceMapsApiKey>()("MAPLE_SOURCEMAPS_API_KEY", {
	issuer: "maple",
	consumers: ["web"],
	environments: PRD_ONLY,
}) {}

export class ProductEventsIngestKey extends Secret<ProductEventsIngestKey>()(
	"MAPLE_PRODUCT_EVENTS_INGEST_KEY",
	// ai and alerting stamp an org's first data, which emits `first_data_received`.
	{ issuer: "maple", consumers: ["api", "ai", "alerting"] },
) {}

// Billing

export class AutumnSecretKey extends Secret<AutumnSecretKey>()("AUTUMN_SECRET_KEY", {
	issuer: "autumn",
	consumers: ["api", "ai", "alerting", "landing", "ingest"],
}) {}

export class AutumnWebhookSecret extends Secret<AutumnWebhookSecret>()("AUTUMN_WEBHOOK_SECRET", {
	issuer: "autumn",
	consumers: ["api"],
	// A preview holding it could sign events that prd accepts.
	environments: ["dev", "prod", "prod-eu"],
}) {}

export class StripeSecretKey extends Secret<StripeSecretKey>()("STRIPE_SECRET_KEY", {
	issuer: "stripe",
	consumers: ["api"],
	environments: PRD_ONLY,
}) {}

// GitHub

export class GithubAppPrivateKey extends Secret<GithubAppPrivateKey>()("GITHUB_APP_PRIVATE_KEY", {
	issuer: "github",
	consumers: ["api", "ai", "alerting"],
	environments: PRD_ONLY,
}) {}

export class GithubAppClientSecret extends Secret<GithubAppClientSecret>()("GITHUB_APP_CLIENT_SECRET", {
	issuer: "github",
	consumers: ["api"],
	environments: PRD_ONLY,
}) {}

export class GithubAppWebhookSecret extends Secret<GithubAppWebhookSecret>()("GITHUB_APP_WEBHOOK_SECRET", {
	issuer: "github",
	consumers: ["api"],
	environments: PRD_ONLY,
}) {}

export class GithubToken extends Secret<GithubToken>()("GITHUB_TOKEN", {
	issuer: "github",
	consumers: ["landing"],
}) {}

// OAuth clients for customer integrations: one client, one secret, so every reader shares it

export class LinearOAuthClientSecret extends Secret<LinearOAuthClientSecret>()("LINEAR_OAUTH_CLIENT_SECRET", {
	issuer: "linear",
	consumers: ["api", "alerting"],
}) {}

export class SearchConsoleClientSecret extends Secret<SearchConsoleClientSecret>()(
	"GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET",
	{ issuer: "google", consumers: ["api", "ai", "alerting"] },
) {}

export class CloudflareOAuthClientSecret extends Secret<CloudflareOAuthClientSecret>()(
	"CLOUDFLARE_OAUTH_CLIENT_SECRET",
	{ issuer: "cloudflare", consumers: ["api", "alerting"], environments: PRD_ONLY },
) {}

export class PlanetScaleOAuthClientSecret extends Secret<PlanetScaleOAuthClientSecret>()(
	"PLANETSCALE_OAUTH_CLIENT_SECRET",
	{ issuer: "planetscale", consumers: ["api", "alerting"], environments: PRD_ONLY },
) {}

export class SupabaseOAuthClientSecret extends Secret<SupabaseOAuthClientSecret>()(
	"SUPABASE_OAUTH_CLIENT_SECRET",
	{ issuer: "supabase", consumers: ["api", "alerting"] },
) {}

// Other third-party credentials

export class StatusDomainsApiToken extends Secret<StatusDomainsApiToken>()("MAPLE_STATUS_DOMAINS_API_TOKEN", {
	issuer: "cloudflare",
	consumers: ["api", "alerting"],
	environments: PRD_ONLY,
}) {}

export class ApnsPrivateKey extends Secret<ApnsPrivateKey>()("APNS_PRIVATE_KEY", {
	issuer: "apple",
	consumers: ["api", "alerting"],
	environments: PRD_ONLY,
}) {}

export class GcpServiceAccountKey extends Secret<GcpServiceAccountKey>()("MAPLE_GCP_SERVICE_ACCOUNT_KEY", {
	issuer: "google",
	consumers: ["alerting"],
}) {}

export class SupportSlackBotToken extends Secret<SupportSlackBotToken>()("MAPLE_SUPPORT_SLACK_BOT_TOKEN", {
	issuer: "slack",
	consumers: ["api"],
	environments: ["dev", "prod", "prod-eu"],
}) {}

export class OpenRouterApiKey extends Secret<OpenRouterApiKey>()("OPENROUTER_API_KEY", {
	issuer: "openrouter",
	consumers: ["ai"],
}) {}
