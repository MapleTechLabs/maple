import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Layer } from "effect"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { Env } from "./Env"

export interface TestGithubConfig {
	readonly dbUrl: string
	readonly appId?: string
	readonly appSlug?: string
	readonly privateKeyPem?: string
	readonly webhookSecret?: string
	readonly githubApiBaseUrl?: string
}

const baseConfig = (cfg: TestGithubConfig): Record<string, string> => ({
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_DB_URL: cfg.dbUrl,
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
})

/** Config provider with all required vars + (optionally) GitHub vars set. */
export const makeTestConfig = (cfg: TestGithubConfig) => {
	const base = baseConfig(cfg)
	if (cfg.appId !== undefined) base.GITHUB_APP_ID = cfg.appId
	if (cfg.appSlug !== undefined) base.GITHUB_APP_SLUG = cfg.appSlug
	if (cfg.privateKeyPem !== undefined) base.GITHUB_APP_PRIVATE_KEY = cfg.privateKeyPem
	if (cfg.webhookSecret !== undefined) base.GITHUB_APP_WEBHOOK_SECRET = cfg.webhookSecret
	if (cfg.githubApiBaseUrl !== undefined) base.GITHUB_API_BASE_URL = cfg.githubApiBaseUrl
	return ConfigProvider.layer(ConfigProvider.fromUnknown(base))
}

/** Composed Env + Database layer for service tests. Cross-wires Env into
 * Database so callers don't have to repeat the provideMerge dance. */
export const makeBaseLayer = (cfg: TestGithubConfig) =>
	DatabaseLibsqlLive.pipe(
		Layer.provideMerge(Env.Default),
		Layer.provide(makeTestConfig(cfg)),
	)

let cachedKey: { pem: string; publicKey: string } | null = null

/** Generate (or reuse) an RSA-2048 key pair for signing test JWTs. */
export const testRsaKey = () => {
	if (cachedKey) return cachedKey
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	})
	cachedKey = { pem: privateKey, publicKey }
	return cachedKey
}

export const fullGithubConfig = (dbUrl: string): TestGithubConfig => ({
	dbUrl,
	appId: "999999",
	appSlug: "maple-test",
	privateKeyPem: testRsaKey().pem,
	webhookSecret: "test-webhook-secret-1234567890",
	githubApiBaseUrl: "http://127.0.0.1:0",
})
