import { afterAll, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { MAPLE_TEST_OIDC_KEY } from "@maple/backend/services/integrations/aws/fake-aws"
import { AwsOidcRouter } from "./aws-oidc.http"

const baseConfig = {
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_API_BASE_URL: "https://api.maple.test/",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
}

const handlerFor = (config: Record<string, string>) =>
	HttpRouter.toWebHandler(
		AwsOidcRouter.pipe(
			Layer.provide(
				Env.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config)))),
			),
		),
		{ disableLogger: true },
	)

const Discovery = Schema.Struct({
	issuer: Schema.String,
	jwks_uri: Schema.String,
	id_token_signing_alg_values_supported: Schema.Array(Schema.String),
})
const Jwks = Schema.Struct({ keys: Schema.Array(Schema.Record(Schema.String, Schema.String)) })

const withKey = handlerFor({ ...baseConfig, MAPLE_AWS_OIDC_SIGNING_KEY: MAPLE_TEST_OIDC_KEY.privateKey })
const withoutKey = handlerFor(baseConfig)
afterAll(() => Promise.all([withKey.dispose(), withoutKey.dispose()]))

// Forged forwarding headers: the issuer must come from configuration, never from the request.
const get = (handler: typeof withKey.handler, path: string) =>
	handler(
		new Request(`https://evil.example${path}`, {
			headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
		}),
	)

describe("AwsOidcRouter", () => {
	it("publishes the issuer AWS discovers, under the configured origin", async () => {
		const response = await get(withKey.handler, "/oidc/aws/.well-known/openid-configuration")
		expect(response.status).toBe(200)
		const doc = Schema.decodeUnknownSync(Discovery)(await response.json())
		expect(doc.issuer).toBe("https://api.maple.test/oidc/aws")
		expect(doc.jwks_uri).toBe("https://api.maple.test/oidc/aws/jwks.json")
		expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"])
	})

	it("serves the public key the tokens verify with, and nothing private", async () => {
		const response = await get(withKey.handler, "/oidc/aws/jwks.json")
		expect(response.status).toBe(200)
		const { keys } = Schema.decodeUnknownSync(Jwks)(await response.json())
		expect(keys).toHaveLength(1)
		expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" })
		const [jwk] = keys
		expect(jwk?.d).toBeUndefined()
		// It is the key the test signs with: the same modulus as the PEM's public half.
		const published = await crypto.subtle.importKey(
			"jwk",
			{ ...jwk },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			true,
			["verify"],
		)
		const spki = Buffer.from(await crypto.subtle.exportKey("spki", published)).toString("base64")
		expect(MAPLE_TEST_OIDC_KEY.publicKey.replace(/-----[A-Z ]+-----|\s/gu, "")).toBe(spki)
	})

	it("is absent without a signing key", async () => {
		expect((await get(withoutKey.handler, "/oidc/aws/jwks.json")).status).toBe(404)
		expect((await get(withoutKey.handler, "/oidc/aws/.well-known/openid-configuration")).status).toBe(404)
	})
})
