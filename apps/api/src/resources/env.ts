/**
 * The api Worker's config-sourced env, resolved as one `Config` so a deploy reports
 * every missing var at once. An explicit catalog, never `Config.*` in init: plan-time
 * auto-bind would bind whatever the deployer's environment holds, as a secret.
 */
import { chatConnectorConfigKeys, chatConnectorOutboundConfigKeys } from "@maple/chat-platform"
import type { MapleDomains, MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	derived,
	githubAppSourceEnv,
	ingestKeyCryptoEnv,
	merge,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	plainWithDefault,
	requireSecretEntry,
	selfObservabilityEnv,
	tinybirdEnv,
} from "@maple/infra/env"

export const apiConfiguredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		tinybirdEnv,
		// ClickHouse (BYO warehouse); `tinybird` unless an org config overrides it.
		optionalPlain("CLICKHOUSE_URL"),
		plainWithDefault("CLICKHOUSE_PROVIDER", "tinybird"),
		optionalPlain("CLICKHOUSE_USER"),
		optionalPlain("CLICKHOUSE_DATABASE"),
		optionalSecret("CLICKHOUSE_PASSWORD"),
		// Dev-only; the runtime ignores it outside MAPLE_ENVIRONMENT=development.
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
		// Dev only: on a deploy a pin would point the whole API at one tenant.
		...(stage.kind === "dev" ? [optionalPlain("MAPLE_ORG_ID_OVERRIDE")] : []),
		authEnv,
		ingestKeyCryptoEnv,
		requireSecretEntry("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		appUrlsEnv(domains),
		// Canonical origin for self-published URLs (MCP `server.json`), never forwarded headers.
		domains.api
			? derived("MAPLE_API_BASE_URL", `https://${domains.api}`)
			: plainWithDefault("MAPLE_API_BASE_URL", "https://api.maple.dev"),
		plainWithDefault("QE_BUCKET_CACHE_ENABLED", "true"),
		plainWithDefault("QE_BUCKET_CACHE_TTL_SECONDS", "86400"),
		plainWithDefault("QE_BUCKET_CACHE_FLUX_SECONDS", "60"),
		plainWithDefault("QE_BUCKET_CACHE_SEGMENT_BUCKETS", "120"),
		// Bounded by Cloudflare's 6-connection limit; keep in step with the defaults in
		// `bucket-cache.ts` and `edge-cache.ts`, or a stale value here overrides them.
		plainWithDefault("QE_BUCKET_CACHE_READ_CONCURRENCY", "6"),
		plainWithDefault("EDGE_CACHE_READ_TIMEOUT_MS", "40"),
		selfObservabilityEnv(stage, region),
		// Webhook signing secrets; each receiver answers 503 until its secret is set.
		optionalSecret("CLERK_WEBHOOK_SECRET"),
		optionalSecret("AUTUMN_WEBHOOK_SECRET"),
		// Defaults to MAPLE_INGEST_KEY; set to land product events in another org.
		optionalSecret("MAPLE_PRODUCT_EVENTS_INGEST_KEY"),
		optionalSecret("AUTUMN_SECRET_KEY"),
		// Billing details go straight to Stripe; Autumn has no API for them.
		optionalSecret("STRIPE_SECRET_KEY"),
		// Shared customer support channels, created in Maple's own Slack workspace.
		optionalSecret("MAPLE_SUPPORT_SLACK_BOT_TOKEN"),
		optionalPlain("MAPLE_SUPPORT_SLACK_TEAM_USER_IDS"),
		optionalSecret("SD_INTERNAL_TOKEN"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		optionalPlain("HAZEL_API_BASE_URL"),
		optionalPlain("HAZEL_OAUTH_DISCOVERY_URL"),
		optionalPlain("HAZEL_OAUTH_CLIENT_ID"),
		optionalSecret("HAZEL_OAUTH_CLIENT_SECRET"),
		optionalPlain("HAZEL_OAUTH_SCOPES"),
		// Each connector's declared install and outbound config; unset means unavailable.
		...[...chatConnectorConfigKeys, ...chatConnectorOutboundConfigKeys].map((key) =>
			key.secret ? optionalSecret(key.name) : optionalPlain(key.name),
		),
		apnsEnv,
		// Repository reading is shared with maple-ai; install and webhooks are api's alone.
		githubAppSourceEnv,
		optionalPlain("GITHUB_APP_CLIENT_ID"),
		optionalSecret("GITHUB_APP_CLIENT_SECRET"),
		optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
	)
