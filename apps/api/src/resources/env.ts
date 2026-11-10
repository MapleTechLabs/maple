/**
 * The api Worker's config-sourced env, resolved as one `Config` so a deploy reports
 * every missing var at once. An explicit catalog, never `Config.*` in init: plan-time
 * auto-bind would bind whatever the deployer's environment holds, as a secret.
 */
import { chatConnectorConfigKeys, chatConnectorOutboundConfigKeys } from "@maple/chat-platform"
import type { MapleDomains, MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import {
	apnsEnv,
	cloudflareOAuthEnv,
	configKeysEnv,
	devOrgOverrideEnv,
	linearOAuthEnv,
	mapleServerEnv,
	merge,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	plainWithDefault,
	requireSecretEntry,
	supabaseOAuthEnv,
} from "@maple/infra/env"

export const apiConfiguredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		mapleServerEnv(stage, region, domains),
		// ClickHouse (BYO warehouse); `tinybird` unless an org config overrides it.
		optionalPlain("CLICKHOUSE_URL"),
		plainWithDefault("CLICKHOUSE_PROVIDER", "tinybird"),
		optionalPlain("CLICKHOUSE_USER"),
		optionalPlain("CLICKHOUSE_DATABASE"),
		optionalSecret("CLICKHOUSE_PASSWORD"),
		devOrgOverrideEnv(stage),
		// PR previews only: the shared key behind the sign-in page's preview access form.
		...(stage.kind === "pr" ? [optionalSecret("PREVIEW_SIGNIN_KEY")] : []),
		requireSecretEntry("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		plainWithDefault("QE_BUCKET_CACHE_ENABLED", "true"),
		plainWithDefault("QE_BUCKET_CACHE_TTL_SECONDS", "86400"),
		plainWithDefault("QE_BUCKET_CACHE_FLUX_SECONDS", "60"),
		plainWithDefault("QE_BUCKET_CACHE_SEGMENT_BUCKETS", "120"),
		// Bounded by Cloudflare's 6-connection limit; keep in step with the defaults in
		// `bucket-cache.ts` and `edge-cache.ts`, or a stale value here overrides them.
		plainWithDefault("QE_BUCKET_CACHE_READ_CONCURRENCY", "6"),
		plainWithDefault("EDGE_CACHE_READ_TIMEOUT_MS", "40"),
		// Webhook signing secrets; each receiver answers 503 until its secret is set.
		optionalSecret("CLERK_WEBHOOK_SECRET"),
		optionalSecret("AUTUMN_WEBHOOK_SECRET"),
		// Defaults to MAPLE_INGEST_KEY; set to land product events in another org.
		optionalSecret("MAPLE_PRODUCT_EVENTS_INGEST_KEY"),
		// Billing details go straight to Stripe; Autumn has no API for them.
		optionalSecret("STRIPE_SECRET_KEY"),
		// Shared customer support channels, created in Maple's own Slack workspace.
		optionalSecret("MAPLE_SUPPORT_SLACK_BOT_TOKEN"),
		optionalPlain("MAPLE_SUPPORT_SLACK_TEAM_USER_IDS"),
		optionalPlain("MAPLE_CANCELLATION_SLACK_CHANNEL_ID"),
		// Cancellation reports also go to this channel of the Hazel workspace Maple's own org linked.
		optionalPlain("MAPLE_CANCELLATION_HAZEL_CHANNEL_ID"),
		optionalPlain("MAPLE_INTERNAL_ORG_ID"),
		optionalPlain("MAPLE_CLERK_DASHBOARD_URL"),
		optionalSecret("SD_INTERNAL_TOKEN"),
		linearOAuthEnv,
		// Each connector's declared install and outbound config.
		configKeysEnv([...chatConnectorConfigKeys, ...chatConnectorOutboundConfigKeys]),
		apnsEnv,
		// The GitHub App's reader is in `mapleServerEnv`; install and webhooks are api's alone.
		optionalPlain("GITHUB_APP_CLIENT_ID"),
		optionalSecret("GITHUB_APP_CLIENT_SECRET"),
		optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
		supabaseOAuthEnv,
		optionalPlain("MAPLE_GCP_SERVICE_ACCOUNT_EMAIL"),
	)
