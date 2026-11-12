// The deployment config the cost provider fakes run their services on.
import { ConfigProvider } from "effect"

const FAKE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

/** `encryptionKey` is `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, for a deployment whose secret key is unusable. */
export const fakeCostEnvConfig = (encryptionKey = FAKE_ENCRYPTION_KEY) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKey,
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
			// OpenRouter's management host is the global one on every instance.
			MAPLE_REGION: "eu",
		}),
	)
