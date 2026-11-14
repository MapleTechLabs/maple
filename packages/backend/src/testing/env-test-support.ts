// `Env` beside the secrets services read as their own services, all from the test's ConfigProvider,
// so a test that sets `GITHUB_APP_PRIVATE_KEY` in its config still hands it to the GitHub client.
import { Layer } from "effect"
import {
	ApnsPrivateKey,
	AutumnWebhookSecret,
	ClerkWebhookSecret,
	CloudflareOAuthClientSecret,
	GcpServiceAccountKey,
	GithubAppClientSecret,
	GithubAppPrivateKey,
	GithubAppWebhookSecret,
	LinearOAuthClientSecret,
	PlanetScaleOAuthClientSecret,
	PreviewSigninKey,
	ProductEventsIngestKey,
	SandboxInternalServiceToken,
	ScraperInternalToken,
	SearchConsoleClientSecret,
	StatusDomainsApiToken,
	StripeSecretKey,
	SupabaseOAuthClientSecret,
	SupportSlackBotToken,
} from "@maple/infra/secrets"
import { Env } from "@maple/backend/platform/Env"

const RuntimeSecretsTestLive = Layer.mergeAll(
	ApnsPrivateKey.layer,
	AutumnWebhookSecret.layer,
	ClerkWebhookSecret.layer,
	CloudflareOAuthClientSecret.layer,
	GcpServiceAccountKey.layer,
	GithubAppClientSecret.layer,
	GithubAppPrivateKey.layer,
	GithubAppWebhookSecret.layer,
	LinearOAuthClientSecret.layer,
	PlanetScaleOAuthClientSecret.layer,
	PreviewSigninKey.layer,
	ProductEventsIngestKey.layer,
	SandboxInternalServiceToken.layer,
	ScraperInternalToken.layer,
	SearchConsoleClientSecret.layer,
	StatusDomainsApiToken.layer,
	StripeSecretKey.layer,
	SupabaseOAuthClientSecret.layer,
	SupportSlackBotToken.layer,
)

/** `Env.layer` for tests, with every runtime secret service a Worker root provides beside it. */
export const EnvTestLive = Layer.mergeAll(Env.layer, RuntimeSecretsTestLive)
