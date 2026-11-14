// The catalog of Maple's own deployment secrets. Export only secret classes: `secret-guard.ts`
// reads the module's exports as the list. Not here: credentials a deploy mints itself, the chat
// connectors' config keys (`@maple/chat-platform`) and the deploy tooling's own credentials.
import { Secret } from "./secret.ts"

// Database URLs (each carries its role's password)

export class MaplePgUrl extends Secret<MaplePgUrl>()("MAPLE_PG_URL", {
	issuer: "postgres",
	consumers: ["managed-db"],
}) {}

export class IngestPgUrl extends Secret<IngestPgUrl>()("MAPLE_INGEST_PG_URL", {
	issuer: "postgres",
	consumers: ["ingest"],
}) {}

// Warehouse

export class TinybirdToken extends Secret<TinybirdToken>()("TINYBIRD_TOKEN", {
	issuer: "tinybird",
	consumers: ["api", "ai", "alerting", "ingest"],
}) {}

export class TinybirdSigningKey extends Secret<TinybirdSigningKey>()("TINYBIRD_SIGNING_KEY", {
	issuer: "tinybird",
	consumers: ["api", "ai", "alerting"],
}) {}

export class ClickhousePassword extends Secret<ClickhousePassword>()("CLICKHOUSE_PASSWORD", {
	issuer: "clickhouse",
	consumers: ["api", "ai", "alerting"],
}) {}

// Session auth

export class MapleRootPassword extends Secret<MapleRootPassword>()("MAPLE_ROOT_PASSWORD", {
	issuer: "maple",
	consumers: ["api", "ai", "alerting", "electric-sync"],
}) {}

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
}) {}

export class PreviewSigninKey extends Secret<PreviewSigninKey>()("PREVIEW_SIGNIN_KEY", {
	issuer: "maple",
	consumers: ["api"],
}) {}

// Keys every reader of the same ciphertext or token must share (docs/secret-encryption.md)

export class IngestKeyEncryptionKey extends Secret<IngestKeyEncryptionKey>()(
	"MAPLE_INGEST_KEY_ENCRYPTION_KEY",
	{ issuer: "maple", consumers: ["api", "ai", "alerting", "chat-bot", "ingest"] },
) {}

export class IngestKeyDecryptionKeys extends Secret<IngestKeyDecryptionKeys>()(
	"MAPLE_INGEST_KEY_DECRYPTION_KEYS",
	{ issuer: "maple", consumers: ["api", "ai", "alerting", "chat-bot", "ingest"] },
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
		"ai",
		"alerting",
		"chat-bot",
		"electric-sync",
		"status",
		"web",
		"scraper",
		"workers-observability",
	],
	boundAs: "MAPLE_INGEST_KEY",
}) {}

export class ProductEventsIngestKey extends Secret<ProductEventsIngestKey>()(
	"MAPLE_PRODUCT_EVENTS_INGEST_KEY",
	{ issuer: "maple", consumers: ["api"] },
) {}

// Billing

export class AutumnSecretKey extends Secret<AutumnSecretKey>()("AUTUMN_SECRET_KEY", {
	issuer: "autumn",
	consumers: ["api", "ai", "alerting", "landing", "ingest"],
}) {}

export class AutumnWebhookSecret extends Secret<AutumnWebhookSecret>()("AUTUMN_WEBHOOK_SECRET", {
	issuer: "autumn",
	consumers: ["api"],
}) {}

export class StripeSecretKey extends Secret<StripeSecretKey>()("STRIPE_SECRET_KEY", {
	issuer: "stripe",
	consumers: ["api"],
}) {}

// GitHub

export class GithubAppPrivateKey extends Secret<GithubAppPrivateKey>()("GITHUB_APP_PRIVATE_KEY", {
	issuer: "github",
	consumers: ["api", "ai", "alerting"],
}) {}

export class GithubAppClientSecret extends Secret<GithubAppClientSecret>()("GITHUB_APP_CLIENT_SECRET", {
	issuer: "github",
	consumers: ["api"],
}) {}

export class GithubAppWebhookSecret extends Secret<GithubAppWebhookSecret>()("GITHUB_APP_WEBHOOK_SECRET", {
	issuer: "github",
	consumers: ["api"],
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
	{ issuer: "cloudflare", consumers: ["api", "alerting"] },
) {}

export class PlanetScaleOAuthClientSecret extends Secret<PlanetScaleOAuthClientSecret>()(
	"PLANETSCALE_OAUTH_CLIENT_SECRET",
	{ issuer: "planetscale", consumers: ["api", "alerting"] },
) {}

export class SupabaseOAuthClientSecret extends Secret<SupabaseOAuthClientSecret>()(
	"SUPABASE_OAUTH_CLIENT_SECRET",
	{ issuer: "supabase", consumers: ["api", "alerting"] },
) {}

// Other third-party credentials

export class StatusDomainsApiToken extends Secret<StatusDomainsApiToken>()("MAPLE_STATUS_DOMAINS_API_TOKEN", {
	issuer: "cloudflare",
	consumers: ["api", "ai", "alerting"],
}) {}

export class ApnsPrivateKey extends Secret<ApnsPrivateKey>()("APNS_PRIVATE_KEY", {
	issuer: "apple",
	consumers: ["api", "alerting"],
}) {}

export class GcpServiceAccountKey extends Secret<GcpServiceAccountKey>()("MAPLE_GCP_SERVICE_ACCOUNT_KEY", {
	issuer: "google",
	consumers: ["alerting"],
}) {}

export class SupportSlackBotToken extends Secret<SupportSlackBotToken>()("MAPLE_SUPPORT_SLACK_BOT_TOKEN", {
	issuer: "slack",
	consumers: ["api"],
}) {}

export class OpenRouterApiKey extends Secret<OpenRouterApiKey>()("OPENROUTER_API_KEY", {
	issuer: "openrouter",
	consumers: ["ai"],
}) {}
