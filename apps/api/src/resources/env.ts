/**
 * Everything in the api worker's env that comes from configuration rather than
 * from a resource. Resolved as one `Config` so a deploy missing several vars
 * reports all of them at once, and so `.env` / `--env-file` reach it — see
 * `@maple/infra/env`.
 *
 * Deliberately an explicit catalog rather than `yield* Config.*` in the
 * Worker's init: alchemy's plan-time auto-bind would bind whatever the
 * deployer's environment happens to hold, as a secret, which defeats the
 * optional-omit rule, the PR-preview exclusions and the `derived` values the
 * environment must not override.
 */
import { chatConnectorConfigKeys } from "@maple/chat-platform"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
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

export const apiConfiguredEnv = (stage: MapleStage, domains: MapleDomains) =>
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
		// Dev stages only: alchemy binds only what is declared here, and on a
		// deploy a pin would point the whole API at one tenant.
		...(stage.kind === "dev" ? [optionalPlain("MAPLE_ORG_ID_OVERRIDE")] : []),
		authEnv,
		ingestKeyCryptoEnv,
		requireSecretEntry("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		appUrlsEnv,
		// The worker's own canonical origin — everything it publishes about itself
		// (MCP `server.json`, the discovery index) is built from this rather than
		// from client-controlled forwarded headers. Stages with a real domain
		// derive it; the rest fall back to production, overridable per deploy.
		domains.api
			? derived("MAPLE_API_BASE_URL", `https://${domains.api}`)
			: plainWithDefault("MAPLE_API_BASE_URL", "https://api.maple.dev"),
		// Bucket-cache knobs: on by default in deployed stages. Override via
		// deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
		plainWithDefault("QE_BUCKET_CACHE_ENABLED", "true"),
		plainWithDefault("QE_BUCKET_CACHE_TTL_SECONDS", "86400"),
		plainWithDefault("QE_BUCKET_CACHE_FLUX_SECONDS", "60"),
		plainWithDefault("QE_BUCKET_CACHE_SEGMENT_BUCKETS", "120"),
		// Both of the next two knobs are bounded by Cloudflare's
		// six-simultaneous-connection limit, which `cache.match()` counts against
		// while it waits for response headers. Keep the deploy-time values in step
		// with the reasoning in `bucket-cache.ts` and `edge-cache.ts` — a stale
		// override here silently defeats a tuned default, which is exactly what
		// happened when these were pinned to 16/250 and the code defaults moved to
		// 6/40 underneath them.
		plainWithDefault("QE_BUCKET_CACHE_READ_CONCURRENCY", "6"),
		plainWithDefault("EDGE_CACHE_READ_TIMEOUT_MS", "40"),
		// MAPLE_ENDPOINT / MAPLE_ENVIRONMENT / COMMIT_SHA / MAPLE_INGEST_KEY.
		selfObservabilityEnv(stage),
		// Svix signing secrets for the public webhook receivers (`/webhooks/clerk`,
		// `/webhooks/autumn`); each route answers 503 until its secret is set.
		optionalSecret("CLERK_WEBHOOK_SECRET"),
		optionalSecret("AUTUMN_WEBHOOK_SECRET"),
		// Server-side product events default to MAPLE_INGEST_KEY; set this only if
		// the funnel should land in a different org than the API's traces.
		optionalSecret("MAPLE_PRODUCT_EVENTS_INGEST_KEY"),
		optionalSecret("AUTUMN_SECRET_KEY"),
		// Billing details (company name, address, tax IDs) are written to the Stripe
		// customer Autumn links; Autumn itself has no API for them.
		optionalSecret("STRIPE_SECRET_KEY"),
		optionalSecret("SD_INTERNAL_TOKEN"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		optionalPlain("HAZEL_API_BASE_URL"),
		optionalPlain("HAZEL_OAUTH_DISCOVERY_URL"),
		optionalPlain("HAZEL_OAUTH_CLIENT_ID"),
		optionalSecret("HAZEL_OAUTH_CLIENT_SECRET"),
		optionalPlain("HAZEL_OAUTH_SCOPES"),
		// Chat connectors bind the install config each one declares; the names live
		// in the connector directory, each says whether it is a secret, and an
		// unset one just reports that connector unavailable. The bot token is not
		// here: the ingress half runs in a different Worker, which binds its own.
		...chatConnectorConfigKeys.map((key) =>
			key.secret ? optionalSecret(key.name) : optionalPlain(key.name),
		),
		// Slack integration (bot install via OAuth v2)
		optionalPlain("SLACK_CLIENT_ID"),
		optionalSecret("SLACK_CLIENT_SECRET"),
		optionalSecret("SLACK_INTERNAL_SERVICE_TOKEN"),
		apnsEnv,
		// The repository-reading half is shared with maple-ai; the install flow and
		// the webhook receiver are this Worker's alone.
		githubAppSourceEnv,
		optionalPlain("GITHUB_APP_SLUG"),
		optionalPlain("GITHUB_APP_CLIENT_ID"),
		optionalSecret("GITHUB_APP_CLIENT_SECRET"),
		optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
	)
