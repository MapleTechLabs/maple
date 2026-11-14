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
	planetScaleOAuthEnv,
	plainWithDefault,
	supabaseOAuthEnv,
} from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"
import { Array as Arr } from "effect"

/** The connectors declare their own secret keys; the Worker env audit accepts these beside the catalog. */
export const apiConnectorSecretNames: ReadonlyArray<string> = Arr.map(
	Arr.filter([...chatConnectorConfigKeys, ...chatConnectorOutboundConfigKeys], (key) => key.secret),
	(key) => key.name,
)

export const apiConfiguredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		mapleServerEnv(stage, region, domains),
		devOrgOverrideEnv(stage),
		// PR previews only: the shared key behind the sign-in page's preview access form.
		...(stage.kind === "pr" ? [Secrets.PreviewSigninKey.optional] : []),
		Secrets.ShareTokenHmacKey.required,
		plainWithDefault("QE_BUCKET_CACHE_ENABLED", "true"),
		plainWithDefault("QE_BUCKET_CACHE_TTL_SECONDS", "86400"),
		plainWithDefault("QE_BUCKET_CACHE_FLUX_SECONDS", "60"),
		plainWithDefault("QE_BUCKET_CACHE_SEGMENT_BUCKETS", "120"),
		// Bounded by Cloudflare's 6-connection limit; keep in step with the defaults in
		// `bucket-cache.ts` and `edge-cache.ts`, or a stale value here overrides them.
		plainWithDefault("QE_BUCKET_CACHE_READ_CONCURRENCY", "6"),
		plainWithDefault("EDGE_CACHE_READ_TIMEOUT_MS", "40"),
		// Webhook signing secrets; each receiver answers 503 until its secret is set.
		Secrets.ClerkWebhookSecret.optional,
		Secrets.AutumnWebhookSecret.optional,
		// Defaults to MAPLE_INGEST_KEY; set to land product events in another org.
		Secrets.ProductEventsIngestKey.optional,
		// Billing details go straight to Stripe; Autumn has no API for them.
		Secrets.StripeSecretKey.optional,
		// Shared customer support channels, created in Maple's own Slack workspace.
		Secrets.SupportSlackBotToken.optional,
		optionalPlain("MAPLE_SUPPORT_SLACK_TEAM_USER_IDS"),
		optionalPlain("MAPLE_CANCELLATION_SLACK_CHANNEL_ID"),
		// Cancellation reports also go to this channel of the Hazel workspace Maple's own org linked.
		optionalPlain("MAPLE_CANCELLATION_HAZEL_CHANNEL_ID"),
		optionalPlain("MAPLE_INTERNAL_ORG_ID"),
		optionalPlain("MAPLE_CLERK_DASHBOARD_URL"),
		Secrets.ScraperInternalToken.optional,
		linearOAuthEnv,
		// Each connector's declared install and outbound config.
		configKeysEnv([...chatConnectorConfigKeys, ...chatConnectorOutboundConfigKeys]),
		apnsEnv,
		// The GitHub App's reader is in `mapleServerEnv`; install and webhooks are api's alone.
		optionalPlain("GITHUB_APP_CLIENT_ID"),
		Secrets.GithubAppClientSecret.optional,
		Secrets.GithubAppWebhookSecret.optional,
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
		supabaseOAuthEnv,
		optionalPlain("MAPLE_GCP_SERVICE_ACCOUNT_EMAIL"),
	)
